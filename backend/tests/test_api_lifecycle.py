"""Exercise the HTTP and SQLite boundaries using synthetic data only."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import base64
import hashlib
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from jsonschema import Draft202012Validator, FormatChecker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant import create_app  # noqa: E402
from ecolephant.contracts import POLICY, SPEC  # noqa: E402
from ecolephant.metrics import aggregate as aggregate_records, timeline as timeline_records  # noqa: E402


def sample(seq, camera, *, quality='valid'):
    valid = quality == 'valid'
    return {
        'seq': seq,
        'elapsed_start_ms': (seq - 1) * 1000,
        'duration_ms': 1000,
        'calibration_epoch': 1,
        'active_mode': 'webcam' if valid else 'none',
        'quality': quality,
        'camera_estimate_deg': camera if valid else None,
        'head_flexion_deg': None,
        'display_angle_deg': camera if valid else None,
        'posture_level': ('high' if camera >= 30 else 'normal') if valid else 'unknown',
        'reason_code': ('forward_shift' if camera >= 30 else 'within_range') if valid else 'insufficient_data',
        'confidence': 'single_sensor' if valid else 'unavailable',
    }


class ApiLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ecolephant-api-')
        self.addCleanup(self.cleanup_temp)
        self.database = Path(self.temp.name) / 'test.sqlite3'
        self.app = self.make_app('test-local-token-a')
        self.client = self.app.test_client()
        self.headers = {'Authorization': 'Bearer test-local-token-a'}
        self.started = datetime(2026, 10, 17, 10, tzinfo=timezone.utc)

    def cleanup_temp(self):
        target = Path(self.temp.name).resolve()
        if target.parent != Path(tempfile.gettempdir()).resolve():
            raise ValueError('Unexpected temporary test directory')
        self.temp.cleanup()

    def make_app(self, token):
        return create_app({
            'TESTING': True,
            'AUTH_MODE': 'local',
            'LOCAL_TOKEN': token,
            'STORAGE': 'sqlite',
            'DATABASE': str(self.database),
            'ALLOWED_ORIGIN': 'http://127.0.0.1:5173',
        })

    def assert_schema(self, name, value):
        schema = {'$ref': f'#/components/schemas/{name}', 'components': SPEC['components']}
        errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value))
        self.assertEqual([(list(error.absolute_path), error.message) for error in errors], [])

    def create_session(self, mode='webcam'):
        payload = {
            'client_session_id': str(uuid4()),
            'started_at': self.started.isoformat(),
            'requested_mode': mode,
            'policy_id': POLICY['policy_id'],
            'initial_calibration_epoch': 1,
            'data_source': 'demo',
        }
        key = str(uuid4())
        headers = {**self.headers, 'Idempotency-Key': key}
        response = self.client.post('/api/v1/sessions', json=payload, headers=headers)
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assert_schema('Session', response.get_json())
        return response.get_json()['id'], payload, headers

    def test_session_list_keeps_default_order_and_pages_latest_first_on_request(self):
        baseline = self.started
        identities = []
        for offset in [0, 0, 1, -1, 1]:
            self.started = baseline + timedelta(hours=offset)
            session_id, _, _ = self.create_session()
            identities.append(session_id)
        response = self.client.get('/api/v1/sessions', query_string={'limit': 100}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        ascending = response.get_json()['items']
        self.assertEqual({item['id'] for item in ascending}, set(identities))
        self.assertEqual(ascending, sorted(ascending, key=lambda item: (item['started_at'], item['id'])))
        cursor, latest = None, []
        for _ in range(4):
            query = {'limit': 2, 'order': 'desc'}
            if cursor:
                query['cursor'] = cursor
            result = self.client.get('/api/v1/sessions', query_string=query, headers=self.headers)
            self.assertEqual(result.status_code, 200, result.get_json())
            self.assert_schema('SessionPage', result.get_json())
            latest.extend(result.get_json()['items'])
            cursor = result.get_json()['next_cursor']
            if cursor is None:
                break
        self.assertIsNone(cursor)
        self.assertEqual([item['id'] for item in latest], [item['id'] for item in reversed(ascending)])
        invalid = self.client.get('/api/v1/sessions', query_string={'order': 'newest'}, headers=self.headers)
        self.assertEqual(invalid.status_code, 422)

    def test_event_cursor_remains_valid_when_the_result_set_is_empty(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        events = [{'event_id': str(uuid4()), 'event_seq': seq, 'elapsed_ms': seq,
                   'type': 'paused', 'data': {}} for seq in (1, 2)]
        self.assertEqual(self.client.post(prefix + '/events:batch', json={'events': events}, headers=self.headers).status_code, 200)
        first = self.client.get(prefix + '/events', query_string={'limit': 1}, headers=self.headers)
        cursor = first.get_json()['next_cursor']
        self.assertIsNotNone(cursor)
        repository = self.app.extensions['repository']
        with patch.object(repository, 'load_events', return_value={'events': {}}):
            empty = self.client.get(prefix + '/events', query_string={'cursor': cursor}, headers=self.headers)
        self.assertEqual(empty.status_code, 200, empty.get_json())
        self.assertEqual(empty.get_json(), {'items': [], 'next_cursor': None})

    def test_event_cursor_rejects_boolean_elapsed_time(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 1, 'type': 'paused', 'data': {}}
        self.assertEqual(self.client.post(prefix + '/events:batch', json={'events': [event]}, headers=self.headers).status_code, 200)
        cursor = base64.urlsafe_b64encode(json.dumps([True, event['event_id']]).encode()).decode()
        response = self.client.get(prefix + '/events', query_string={'cursor': cursor}, headers=self.headers)
        self.assertEqual(response.status_code, 422)

    def test_aligned_timeline_matches_raw_windows_without_loading_them(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        first = [sample(seq, None, quality='no_sensor') if seq % 11 == 0 else sample(seq, 35 if seq % 3 == 0 else 10)
                 for seq in range(1, 60)]
        self.assertEqual(self.client.post(prefix + '/samples:batch', json={'samples': first}, headers=self.headers).status_code, 200)
        short, crossing, final = sample(60, 10), sample(61, 35), sample(62, 10)
        short['duration_ms'] = 500
        crossing['elapsed_start_ms'] = 59500
        final['elapsed_start_ms'] = 60500
        response = self.client.post(prefix + '/samples:batch', json={'samples': [short, crossing, final]}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        repository = self.app.extensions['repository']
        token = self.headers['Authorization'].removeprefix('Bearer ')
        owner = 'local-' + hashlib.sha256(token.encode()).hexdigest()[:24]
        record = repository.load(owner, session_id)
        expected = timeline_records(record, 0, 61500)
        with patch.object(repository, 'load', side_effect=AssertionError('Aligned timeline read every sample')):
            actual = self.client.get(prefix + '/timeline', headers=self.headers)
            last = self.client.get(prefix + '/timeline', query_string={'from_elapsed_ms': 60000}, headers=self.headers)
        self.assertEqual(actual.status_code, 200, actual.get_json())
        self.assertEqual(actual.get_json()['buckets'], expected)
        self.assertEqual(last.get_json()['buckets'], expected[1:])
        with patch.object(repository, 'load', wraps=repository.load) as full_load:
            partial = self.client.get(prefix + '/timeline', query_string={'from_elapsed_ms': 500,
                                      'to_elapsed_ms': 60500}, headers=self.headers)
        self.assertEqual(partial.status_code, 200, partial.get_json())
        self.assertEqual(partial.get_json()['buckets'], timeline_records(record, 500, 60500))
        self.assertGreater(full_load.call_count, 0)

    def test_timeline_index_survives_boundary_alert_and_cleans_up_on_delete(self):
        session_id, _, _ = self.create_session('combined')
        prefix = f'/api/v1/sessions/{session_id}'
        first = self.client.post(prefix + '/samples:batch',
                                 json={'samples': [sample(seq, 10) for seq in range(1, 61)]}, headers=self.headers)
        self.assertEqual(first.status_code, 200, first.get_json())
        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 60000, 'type': 'alert_delivery',
                 'data': {'alert_id': str(uuid4()), 'stage': 1, 'channel': 'screen', 'result': 'delivered'}}
        self.assertEqual(self.client.post(prefix + '/events:batch', json={'events': [event]}, headers=self.headers).status_code, 200)
        airpods = sample(61, 10)
        airpods.update(active_mode='airpods', camera_estimate_deg=None, head_flexion_deg=10)
        self.assertEqual(self.client.post(prefix + '/samples:batch', json={'samples': [airpods]}, headers=self.headers).status_code, 200)
        repository = self.app.extensions['repository']
        with patch.object(repository, 'load', side_effect=AssertionError('Boundary alert discarded the index')):
            response = self.client.get(prefix + '/timeline', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual([bucket['active_modes'] for bucket in response.get_json()['buckets']], [['webcam'], ['airpods']])
        self.assertEqual(self.client.delete(prefix, headers=self.headers).status_code, 204)
        self.assertEqual(self.client.get(prefix + '/timeline', headers=self.headers).status_code, 404)
        if hasattr(repository, 'database'):
            with repository.connection() as conn:
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM timeline_buckets WHERE session_id=?', (session_id,)).fetchone()[0], 0)
        else:
            self.assertEqual(repository.query('session#' + session_id, 'timeline#'), [])

    def test_missing_timeline_bucket_falls_back_to_original_results(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        response = self.client.post(prefix + '/samples:batch',
                                    json={'samples': [sample(seq, 10) for seq in range(1, 61)]}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        repository = self.app.extensions['repository']
        token = self.headers['Authorization'].removeprefix('Bearer ')
        owner = 'local-' + hashlib.sha256(token.encode()).hexdigest()[:24]
        expected = timeline_records(repository.load(owner, session_id), 0, 60000)
        if hasattr(repository, 'database'):
            with repository.connection() as conn:
                conn.execute('DELETE FROM timeline_buckets WHERE session_id=? AND start_ms=0', (session_id,))
        else:
            repository.table.delete_item(Key={'pk': 'session#' + session_id, 'sk': 'timeline#0000000000000000'})
        with patch.object(repository, 'load', wraps=repository.load) as full_load:
            actual = self.client.get(prefix + '/timeline', headers=self.headers)
        self.assertEqual(actual.status_code, 200, actual.get_json())
        self.assertEqual(actual.get_json()['buckets'], expected)
        self.assertGreater(full_load.call_count, 0)

    def test_out_of_order_timeline_uses_complete_original_results(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        for item in [sample(2, 35), sample(1, 10)]:
            result = self.client.post(prefix + '/samples:batch', json={'samples': [item]}, headers=self.headers)
            self.assertEqual(result.status_code, 200, result.get_json())
        repository = self.app.extensions['repository']
        with patch.object(repository, 'load', wraps=repository.load) as full_load:
            result = self.client.get(prefix + '/timeline', headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        self.assertEqual(result.get_json()['buckets'][0]['normal_ms'], 1000)
        self.assertEqual(result.get_json()['buckets'][0]['high_ms'], 1000)
        self.assertGreater(full_load.call_count, 0)

    def test_invalid_partial_timeline_cache_is_ignored_without_losing_samples(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        self.assertEqual(self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10)]}, headers=self.headers).status_code, 200)
        repository = self.app.extensions['repository']
        token = self.headers['Authorization'].removeprefix('Bearer ')
        owner = 'local-' + hashlib.sha256(token.encode()).hexdigest()[:24]
        metadata = repository.load_metadata(owner, session_id)
        metadata['append_state']['timeline_cache']['partial']['unknown_ms'] = 1
        repository.commit(owner, metadata)
        with patch.object(repository, 'load', wraps=repository.load) as full_load:
            current = self.client.get(prefix + '/timeline', headers=self.headers)
        self.assertEqual(current.status_code, 200, current.get_json())
        self.assertEqual(current.get_json()['buckets'][0]['normal_ms'], 1000)
        self.assertGreater(full_load.call_count, 0)
        added = self.client.post(prefix + '/samples:batch', json={'samples': [sample(2, 10)]}, headers=self.headers)
        self.assertEqual(added.status_code, 200, added.get_json())
        self.assertNotIn('timeline_cache', repository.load_metadata(owner, session_id)['append_state'])
        self.assertEqual(self.client.get(prefix + '/timeline', headers=self.headers).get_json()['buckets'][0]['normal_ms'], 2000)

    def test_missing_partial_cache_field_falls_back_and_disables_cache(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        first = self.client.post(prefix + '/samples:batch',
                                 json={'samples': [sample(seq, 10) for seq in range(1, 61)]}, headers=self.headers)
        self.assertEqual(first.status_code, 200, first.get_json())
        repository = self.app.extensions['repository']
        token = self.headers['Authorization'].removeprefix('Bearer ')
        owner = 'local-' + hashlib.sha256(token.encode()).hexdigest()[:24]
        metadata = repository.load_metadata(owner, session_id)
        metadata['append_state']['timeline_cache'].pop('partial')
        repository.commit(owner, metadata)
        with patch.object(repository, 'load', wraps=repository.load) as full_load:
            current = self.client.get(prefix + '/timeline', headers=self.headers)
        self.assertEqual(current.status_code, 200, current.get_json())
        self.assertEqual(current.get_json()['buckets'][0]['normal_ms'], 60000)
        self.assertGreater(full_load.call_count, 0)
        added = self.client.post(prefix + '/samples:batch', json={'samples': [sample(61, 10)]}, headers=self.headers)
        self.assertEqual(added.status_code, 200, added.get_json())
        self.assertNotIn('timeline_cache', repository.load_metadata(owner, session_id)['append_state'])

    def test_indexed_timeline_matches_mixed_modes_and_short_windows(self):
        session_id, _, _ = self.create_session('combined')
        prefix = f'/api/v1/sessions/{session_id}'
        samples, cursor = [], 0
        for seq in range(1, 186):
            item = sample(seq, None, quality='no_sensor') if seq % 7 == 0 else sample(seq, 35 if seq % 3 == 0 else 10)
            if seq % 5 == 0 and item['quality'] == 'valid':
                angle = item['display_angle_deg']
                item.update(active_mode='airpods', camera_estimate_deg=None, head_flexion_deg=angle,
                            reason_code='head_flexion' if angle >= 30 else 'within_range')
            item['elapsed_start_ms'] = cursor
            item['duration_ms'] = 500 if seq % 13 == 0 else 1000
            cursor += item['duration_ms']
            samples.append(item)
        for offset in range(0, len(samples), 60):
            response = self.client.post(prefix + '/samples:batch', json={'samples': samples[offset:offset + 60]}, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.get_json())
        repository = self.app.extensions['repository']
        token = self.headers['Authorization'].removeprefix('Bearer ')
        owner = 'local-' + hashlib.sha256(token.encode()).hexdigest()[:24]
        record = repository.load(owner, session_id)
        with patch.object(repository, 'load', side_effect=AssertionError('Indexed range read every sample')):
            for low, high in [(0, 120000), (60000, 120000), (120000, cursor)]:
                response = self.client.get(prefix + '/timeline', query_string={'from_elapsed_ms': low,
                                           'to_elapsed_ms': high}, headers=self.headers)
                self.assertEqual(response.status_code, 200, response.get_json())
                self.assertEqual(response.get_json()['buckets'], timeline_records(record, low, high))

    def test_conflicting_minute_write_is_atomic_and_retryable(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        first = self.client.post(prefix + '/samples:batch',
                                 json={'samples': [sample(seq, 10) for seq in range(1, 60)]}, headers=self.headers)
        self.assertEqual(first.status_code, 200, first.get_json())
        repository = self.app.extensions['repository']
        original_commit = repository.commit
        def commit_after_competing_write(owner, record, **kwargs):
            competing = repository.load(owner, session_id)
            original_commit(owner, competing)
            return original_commit(owner, record, **kwargs)
        with patch.object(repository, 'commit', side_effect=commit_after_competing_write):
            rejected = self.client.post(prefix + '/samples:batch', json={'samples': [sample(60, 35)]}, headers=self.headers)
        self.assertEqual(rejected.status_code, 409, rejected.get_json())
        before = self.client.get(prefix + '/timeline', headers=self.headers).get_json()['buckets']
        self.assertEqual((before[0]['duration_ms'], before[0]['high_ms']), (59000, 0))
        retry = self.client.post(prefix + '/samples:batch', json={'samples': [sample(60, 35)]}, headers=self.headers)
        self.assertEqual(retry.status_code, 200, retry.get_json())
        after = self.client.get(prefix + '/timeline', headers=self.headers).get_json()['buckets']
        self.assertEqual((after[0]['duration_ms'], after[0]['high_ms']), (60000, 1000))

    def test_append_and_read_paths_do_not_load_old_samples(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        first = self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10), sample(2, 35)]}, headers=self.headers)
        self.assertEqual(first.status_code, 200, first.get_json())
        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 1000, 'type': 'paused', 'data': {}}
        received = self.client.post(prefix + '/events:batch', json={'events': [event]}, headers=self.headers)
        self.assertEqual(received.status_code, 200, received.get_json())
        repository = self.app.extensions['repository']
        with patch.object(repository, 'load', side_effect=AssertionError('Full session load is unnecessary')):
            added = self.client.post(prefix + '/samples:batch',
                                     json={'samples': [sample(3, 10), sample(4, None, quality='no_sensor')]}, headers=self.headers)
            self.assertEqual(added.status_code, 200, added.get_json())
            self.assertEqual(added.get_json()['acknowledged_through_seq'], 4)
            detail = self.client.get(prefix, headers=self.headers)
            events = self.client.get(prefix + '/events', headers=self.headers)
        self.assertEqual(detail.status_code, 200, detail.get_json())
        self.assert_schema('Session', detail.get_json())
        metrics = detail.get_json()['summaries'][0]['metrics']
        self.assertEqual((metrics['normal_duration_ms'], metrics['high_duration_ms']), (2000, 1000))
        self.assertAlmostEqual(metrics['mean_display_angle_deg'], 55 / 3)
        self.assertEqual(detail.get_json()['unassigned_unknown_duration_ms'], 1000)
        self.assertEqual(events.get_json()['items'], [event])

    def test_invalid_contiguous_batch_is_atomic(self):
        session_id, _, _ = self.create_session()
        path = f'/api/v1/sessions/{session_id}/samples:batch'
        self.assertEqual(self.client.post(path, json={'samples': [sample(1, 10)]}, headers=self.headers).status_code, 200)
        invalid = sample(3, 35)
        invalid['display_angle_deg'] = 34
        response = self.client.post(path, json={'samples': [sample(2, 10), invalid]}, headers=self.headers)
        self.assertEqual(response.status_code, 422, response.get_json())
        repository = self.app.extensions['repository']
        with patch.object(repository, 'load', side_effect=AssertionError('Valid retry read history')):
            retry = self.client.post(path, json={'samples': [sample(2, 10), sample(3, 35)]}, headers=self.headers)
        self.assertEqual(retry.status_code, 200, retry.get_json())
        self.assertEqual((retry.get_json()['accepted_count'], retry.get_json()['acknowledged_through_seq']), (2, 3))

    def test_metadata_and_event_reads_enforce_owner_and_deletion(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 0, 'type': 'paused', 'data': {}}
        self.assertEqual(self.client.post(prefix + '/events:batch', json={'events': [event]}, headers=self.headers).status_code, 200)
        other = self.make_app('test-local-token-b').test_client()
        other_headers = {'Authorization': 'Bearer test-local-token-b'}
        self.assertEqual(other.get(prefix, headers=other_headers).status_code, 404)
        self.assertEqual(other.get(prefix + '/events', headers=other_headers).status_code, 404)
        self.assertEqual(self.client.delete(prefix, headers=self.headers).status_code, 204)
        self.assertEqual(self.client.get(prefix, headers=self.headers).status_code, 404)
        self.assertEqual(self.client.get(prefix + '/events', headers=self.headers).status_code, 404)

    def test_fast_append_preserves_all_sensor_mode_groups(self):
        session_id, _, _ = self.create_session('combined')
        prefix = f'/api/v1/sessions/{session_id}'
        airpods = sample(2, 10)
        airpods.update(active_mode='airpods', camera_estimate_deg=None, head_flexion_deg=10)
        combined = sample(3, 10)
        weights = POLICY['fusion_weights']
        combined.update(active_mode='combined', camera_estimate_deg=40, head_flexion_deg=5,
                        display_angle_deg=40 * weights['webcam'] + 5 * weights['airpods'],
                        posture_level='high', reason_code='forward_shift', confidence='dual_sensor')
        batches = [[sample(1, 10), airpods], [combined, sample(4, None, quality='no_sensor')]]
        repository = self.app.extensions['repository']
        with patch.object(repository, 'load', side_effect=AssertionError('Contiguous append read history')):
            for batch in batches:
                response = self.client.post(prefix + '/samples:batch', json={'samples': batch}, headers=self.headers)
                self.assertEqual(response.status_code, 200, response.get_json())
        token = self.headers['Authorization'].removeprefix('Bearer ')
        owner = 'local-' + hashlib.sha256(token.encode()).hexdigest()[:24]
        record = repository.load(owner, session_id)
        summaries, unknown = aggregate_records([record])
        actual = self.client.get(prefix, headers=self.headers).get_json()
        self.assertEqual(actual['summaries'], summaries)
        self.assertEqual({group['active_mode'] for group in summaries}, {'webcam', 'airpods', 'combined'})
        self.assertEqual(actual['unassigned_unknown_duration_ms'], unknown)

    def test_out_of_order_samples_fall_back_then_resume_fast_append(self):
        session_id, _, _ = self.create_session()
        path = f'/api/v1/sessions/{session_id}/samples:batch'
        second = self.client.post(path, json={'samples': [sample(2, 35)]}, headers=self.headers)
        self.assertEqual(second.status_code, 200, second.get_json())
        self.assertEqual(second.get_json()['acknowledged_through_seq'], 0)
        first = self.client.post(path, json={'samples': [sample(1, 10)]}, headers=self.headers)
        self.assertEqual(first.status_code, 200, first.get_json())
        self.assertEqual(first.get_json()['acknowledged_through_seq'], 2)
        repository = self.app.extensions['repository']
        with patch.object(repository, 'load', side_effect=AssertionError('Contiguous append read history')):
            third = self.client.post(path, json={'samples': [sample(3, 10)]}, headers=self.headers)
        self.assertEqual(third.status_code, 200, third.get_json())
        self.assertEqual(third.get_json()['acknowledged_through_seq'], 3)

    def test_legacy_record_without_append_state_is_safely_rebuilt(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        self.assertEqual(self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10)]}, headers=self.headers).status_code, 200)
        repository = self.app.extensions['repository']
        token = self.headers['Authorization'].removeprefix('Bearer ')
        owner = 'local-' + hashlib.sha256(token.encode()).hexdigest()[:24]
        record = repository.load(owner, session_id)
        record.pop('append_state', None)
        repository.commit(owner, record)
        restored = self.client.post(prefix + '/samples:batch', json={'samples': [sample(2, 35)]}, headers=self.headers)
        self.assertEqual(restored.status_code, 200, restored.get_json())
        with patch.object(repository, 'load', side_effect=AssertionError('Rebuilt record read history')):
            third = self.client.post(prefix + '/samples:batch', json={'samples': [sample(3, 10)]}, headers=self.headers)
        self.assertEqual(third.status_code, 200, third.get_json())

    def test_alert_at_append_boundary_is_reassigned_using_full_validation(self):
        session_id, _, _ = self.create_session('combined')
        prefix = f'/api/v1/sessions/{session_id}'
        self.assertEqual(self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10)]}, headers=self.headers).status_code, 200)
        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 1000, 'type': 'alert_delivery',
                 'data': {'alert_id': str(uuid4()), 'stage': 1, 'channel': 'screen', 'result': 'delivered'}}
        self.assertEqual(self.client.post(prefix + '/events:batch', json={'events': [event]}, headers=self.headers).status_code, 200)
        second = sample(2, 10)
        second.update(active_mode='airpods', camera_estimate_deg=None, head_flexion_deg=10)
        repository = self.app.extensions['repository']
        with patch.object(repository, 'load', wraps=repository.load) as full_load:
            response = self.client.post(prefix + '/samples:batch', json={'samples': [second]}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertGreater(full_load.call_count, 0)
        detail = self.client.get(prefix, headers=self.headers).get_json()
        groups = {group['active_mode']: group['metrics'] for group in detail['summaries']}
        self.assertEqual(groups['webcam']['first_stage_alert_count'], 0)
        self.assertEqual(groups['airpods']['first_stage_alert_count'], 1)

    def test_stale_append_cannot_overwrite_concurrent_update(self):
        session_id, _, _ = self.create_session()
        path = f'/api/v1/sessions/{session_id}/samples:batch'
        self.assertEqual(self.client.post(path, json={'samples': [sample(1, 10)]}, headers=self.headers).status_code, 200)
        repository = self.app.extensions['repository']
        original_commit = repository.commit
        def commit_after_competing_write(owner, record, **kwargs):
            competing = repository.load(owner, session_id)
            original_commit(owner, competing)
            return original_commit(owner, record, **kwargs)
        with patch.object(repository, 'commit', side_effect=commit_after_competing_write):
            rejected = self.client.post(path, json={'samples': [sample(2, 35)]}, headers=self.headers)
        self.assertEqual(rejected.status_code, 409, rejected.get_json())
        accepted = self.client.post(path, json={'samples': [sample(2, 35)]}, headers=self.headers)
        self.assertEqual(accepted.status_code, 200, accepted.get_json())
        retried = self.client.post(path, json={'samples': [sample(2, 35)]}, headers=self.headers)
        self.assertEqual(retried.get_json()['duplicate_count'], 1)

    def test_incremental_summaries_match_complete_recalculation(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        repository = self.app.extensions['repository']
        token = self.headers['Authorization'].removeprefix('Bearer ')
        owner = 'local-' + hashlib.sha256(token.encode()).hexdigest()[:24]
        for offset in range(0, 100, 10):
            samples = [sample(seq, None, quality='no_sensor') if seq % 7 == 0 else sample(seq, 35.1 if seq % 3 == 0 else 10.1)
                       for seq in range(offset + 1, offset + 11)]
            response = self.client.post(prefix + '/samples:batch', json={'samples': samples}, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.get_json())
            if offset == 20:
                alert = str(uuid4())
                events = [
                    {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 1000, 'type': 'alert_delivery',
                     'data': {'alert_id': alert, 'stage': 1, 'channel': 'screen', 'result': 'delivered'}},
                    {'event_id': str(uuid4()), 'event_seq': 2, 'elapsed_ms': 1500, 'type': 'correction_observed',
                     'data': {'alert_id': alert, 'outcome': 'corrected'}},
                ]
                event_result = self.client.post(prefix + '/events:batch', json={'events': events}, headers=self.headers)
                self.assertEqual(event_result.status_code, 200, event_result.get_json())
            record = repository.load(owner, session_id)
            expected, unknown = aggregate_records([record])
            actual = self.client.get(prefix, headers=self.headers).get_json()
            self.assertEqual(actual['summaries'], expected)
            self.assertEqual(actual['unassigned_unknown_duration_ms'], unknown)

    def test_session_lifecycle_retries_statistics_and_delete(self):
        session_id, payload, headers = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        retry = self.client.post('/api/v1/sessions', json=payload, headers=headers)
        self.assertEqual(retry.status_code, 201)
        self.assertEqual(retry.get_json()['id'], session_id)
        policies = self.client.get('/api/v1/policies', headers=self.headers)
        self.assertEqual(policies.status_code, 200)
        self.assert_schema('PolicyPage', policies.get_json())

        batch = {'samples': [sample(1, 10), sample(2, 35), sample(3, None, quality='no_sensor')]}
        result = self.client.post(prefix + '/samples:batch', json=batch, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        self.assert_schema('BatchReceipt', result.get_json())
        self.assertEqual(result.get_json()['acknowledged_through_seq'], 3)
        retry_batch = self.client.post(prefix + '/samples:batch', json=batch, headers=self.headers)
        self.assertEqual(retry_batch.get_json()['duplicate_count'], 3)
        conflict = self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 35)]}, headers=self.headers)
        self.assertEqual(conflict.status_code, 409)

        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 1000, 'type': 'paused', 'data': {}}
        result = self.client.post(prefix + '/events:batch', json={'events': [event]}, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        self.assert_schema('EventReceipt', result.get_json())
        event_page = self.client.get(prefix + '/events', headers=self.headers)
        self.assert_schema('EventPage', event_page.get_json())
        self.assertEqual(len(event_page.get_json()['items']), 1)
        end = (self.started + timedelta(seconds=3)).isoformat()
        missing = {'ended_at': end, 'final_seq': 4, 'final_event_seq': 1}
        self.assertEqual(self.client.post(prefix + '/complete', json=missing, headers=self.headers).status_code, 409)
        complete = {'ended_at': end, 'final_seq': 3, 'final_event_seq': 1}
        done = self.client.post(prefix + '/complete', json=complete, headers=self.headers)
        self.assertEqual(done.status_code, 200, done.get_json())
        self.assert_schema('Session', done.get_json())
        self.assertEqual(done.get_json()['status'], 'completed')
        metrics = done.get_json()['summaries'][0]['metrics']
        self.assertEqual(metrics['valid_duration_ms'], 2000)
        self.assertEqual(metrics['normal_duration_ms'], 1000)
        self.assertEqual(metrics['high_duration_ms'], 1000)
        self.assertEqual(metrics['within_range_percent'], 50)
        self.assertEqual(done.get_json()['unassigned_unknown_duration_ms'], 1000)
        self.assertEqual(self.client.post(prefix + '/complete', json=complete, headers=self.headers).status_code, 200)
        timeline = self.client.get(prefix + '/timeline', headers=self.headers)
        self.assertEqual(timeline.status_code, 200)
        self.assert_schema('Timeline', timeline.get_json())
        sessions = self.client.get('/api/v1/sessions', headers=self.headers)
        self.assertEqual(sessions.status_code, 200)
        self.assert_schema('SessionPage', sessions.get_json())
        stats = self.client.get('/api/v1/statistics', query_string={
            'from': self.started.isoformat(), 'to': (self.started + timedelta(days=1)).isoformat(),
            'group_by': 'day', 'timezone': 'UTC',
        }, headers=self.headers)
        self.assertEqual(stats.status_code, 200, stats.get_json())
        self.assert_schema('StatisticsResponse', stats.get_json())
        self.assertEqual(stats.get_json()['groups'][0]['summary']['valid_duration_ms'], 2000)
        self.assertEqual(self.client.delete(prefix, headers=self.headers).status_code, 204)
        self.assertEqual(self.client.get(prefix, headers=self.headers).status_code, 404)
        self.assertEqual(self.client.post('/api/v1/sessions', json=payload, headers=headers).status_code, 409)

    def test_statistics_preserve_millisecond_query_boundaries(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        result = self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10), sample(2, 35)]}, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        final = {'ended_at': (self.started + timedelta(seconds=2)).isoformat(), 'final_seq': 2, 'final_event_seq': 0}
        self.assertEqual(self.client.post(prefix + '/complete', json=final, headers=self.headers).status_code, 200)
        stats = self.client.get('/api/v1/statistics', query_string={
            'from': (self.started + timedelta(milliseconds=1001)).isoformat(),
            'to': (self.started + timedelta(seconds=2)).isoformat(), 'group_by': 'hour', 'timezone': 'UTC',
        }, headers=self.headers)
        self.assertEqual(stats.status_code, 200, stats.get_json())
        metrics = stats.get_json()['groups'][0]['summary']
        self.assertEqual(metrics['valid_duration_ms'], 999)
        self.assertEqual(metrics['high_duration_ms'], 999)

    def test_session_start_rejects_submillisecond_precision_without_losing_valid_trailing_zeros(self):
        _, payload, _ = self.create_session()
        payload['client_session_id'] = str(uuid4())
        payload['started_at'] = '2026-10-17T10:00:00.1230000001Z'
        headers = {**self.headers, 'Idempotency-Key': str(uuid4())}
        rejected = self.client.post('/api/v1/sessions', json=payload, headers=headers)
        self.assertEqual(rejected.status_code, 422, rejected.get_json())
        payload['started_at'] = '2026-10-17T19:00:00.1230000+09:00'
        accepted = self.client.post('/api/v1/sessions', json=payload, headers=headers)
        self.assertEqual(accepted.status_code, 201, accepted.get_json())
        self.assertEqual(accepted.get_json()['started_at'], '2026-10-17T10:00:00.123Z')

    def test_session_end_rejects_submillisecond_time_before_completing(self):
        session_id, _, _ = self.create_session()
        path = f'/api/v1/sessions/{session_id}/complete'
        complete = {'ended_at': '2026-10-17T10:00:00.0000001Z', 'final_seq': 0, 'final_event_seq': 0}
        rejected = self.client.post(path, json=complete, headers=self.headers)
        self.assertEqual(rejected.status_code, 422, rejected.get_json())
        complete['ended_at'] = '2026-10-17T10:00:00.000000Z'
        accepted = self.client.post(path, json=complete, headers=self.headers)
        self.assertEqual(accepted.status_code, 200, accepted.get_json())
        self.assertEqual(accepted.get_json()['status'], 'completed')

    def test_period_queries_reject_submillisecond_or_non_rfc3339_timestamps(self):
        self.create_session()
        start, end = '2026-10-17T10:00:00Z', '2026-10-17T10:00:01Z'
        cases = [('2026-10-17T10:00:00.0000001Z', end),
                 (start, '2026-10-17T10:00:01.0001Z'),
                 ('2026-10-17 10:00:00+00:00', end)]
        for path in ['/api/v1/sessions', '/api/v1/statistics']:
            for low, high in cases:
                with self.subTest(path=path, low=low, high=high):
                    response = self.client.get(path, query_string={
                        'from': low, 'to': high, 'group_by': 'hour', 'timezone': 'UTC',
                    }, headers=self.headers)
                    self.assertEqual(response.status_code, 422, response.get_json())
            accepted = self.client.get(path, query_string={
                'from': '2026-10-17T19:00:00.000000+09:00', 'to': end,
                'group_by': 'hour', 'timezone': 'UTC',
            }, headers=self.headers)
            self.assertEqual(accepted.status_code, 200, accepted.get_json())

    def test_long_timeline_uses_bounded_pages_without_inventing_future_time(self):
        session_id, _, _ = self.create_session()
        repository = self.app.extensions['repository']
        token = self.headers['Authorization'].removeprefix('Bearer ')
        owner = 'local-' + hashlib.sha256(token.encode()).hexdigest()[:24]
        record = repository.load(owner, session_id)
        record.get('append_state', {}).pop('timeline_cache', None)
        repository.commit(owner, record)
        first_sample = sample(1, 10)
        last_sample = sample(2, 35)
        last_sample['elapsed_start_ms'] = 86400000
        record['samples'] = {1: first_sample, 2: last_sample}
        path = f'/api/v1/sessions/{session_id}/timeline'
        with patch.object(repository, 'load', return_value=record):
            first = self.client.get(path, headers=self.headers)
            self.assertEqual(first.status_code, 200, first.get_json())
            self.assert_schema('Timeline', first.get_json())
            self.assertEqual(first.get_json()['next_from_elapsed_ms'], 86400000)
            self.assertEqual(len(first.get_json()['buckets']), 1440)
            last = self.client.get(path, query_string={'from_elapsed_ms': 86400000,
                                   'to_elapsed_ms': 86460000}, headers=self.headers)
            self.assertEqual(last.status_code, 200, last.get_json())
            self.assert_schema('Timeline', last.get_json())
            self.assertIsNone(last.get_json()['next_from_elapsed_ms'])
            self.assertEqual(last.get_json()['buckets'][0]['duration_ms'], 1000)
            self.assertEqual(last.get_json()['buckets'][0]['high_ms'], 1000)
            empty = self.client.get(path, query_string={'from_elapsed_ms': 86401000}, headers=self.headers)
            self.assertEqual(empty.status_code, 200, empty.get_json())
            self.assertEqual(empty.get_json()['buckets'], [])
            self.assertIsNone(empty.get_json()['next_from_elapsed_ms'])
            invalid = self.client.get(path, query_string={'from_elapsed_ms': 0,
                                      'to_elapsed_ms': 86400001}, headers=self.headers)
            self.assertEqual(invalid.status_code, 422)

    def test_empty_timeline_has_no_next_page(self):
        session_id, _, _ = self.create_session()
        path = f'/api/v1/sessions/{session_id}/timeline'
        response = self.client.get(path, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assert_schema('Timeline', response.get_json())
        self.assertEqual(response.get_json()['buckets'], [])
        self.assertIsNone(response.get_json()['next_from_elapsed_ms'])

    def test_session_end_alert_is_counted_in_the_next_hour_and_last_active_mode(self):
        self.started = datetime(2026, 10, 17, 10, 59, 40, tzinfo=timezone.utc)
        session_id, _, _ = self.create_session('combined')
        prefix = f'/api/v1/sessions/{session_id}'
        result = self.client.post(prefix + '/samples:batch',
                                  json={'samples': [sample(seq, 35) for seq in range(1, 21)]}, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 20000, 'type': 'alert_delivery',
                 'data': {'alert_id': str(uuid4()), 'stage': 1, 'channel': 'screen', 'result': 'delivered'}}
        result = self.client.post(prefix + '/events:batch', json={'events': [event]}, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        final = {'ended_at': (self.started + timedelta(seconds=20)).isoformat(), 'final_seq': 20, 'final_event_seq': 1}
        done = self.client.post(prefix + '/complete', json=final, headers=self.headers)
        self.assertEqual(done.status_code, 200, done.get_json())
        stats = self.client.get('/api/v1/statistics', query_string={
            'from': self.started.isoformat(), 'to': (self.started + timedelta(seconds=21)).isoformat(),
            'group_by': 'hour', 'timezone': 'UTC',
        }, headers=self.headers)
        self.assertEqual(stats.status_code, 200, stats.get_json())
        groups = stats.get_json()['groups']
        self.assertEqual([group['active_mode'] for group in groups], ['webcam'])
        self.assertEqual(groups[0]['summary']['first_stage_alert_count'], 1)
        buckets = groups[0]['buckets']
        self.assertEqual(len(buckets), 2)
        self.assertEqual([bucket['metrics']['first_stage_alert_count'] for bucket in buckets], [0, 1])
        self.assertEqual(buckets[1]['metrics']['valid_duration_ms'], 0)
        self.assertIsNone(buckets[1]['metrics']['within_range_percent'])

    def test_daily_statistics_split_at_seoul_midnight(self):
        self.started = datetime(2026, 10, 17, 14, 59, 59, 500000, tzinfo=timezone.utc)
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        result = self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10), sample(2, 35)]}, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        final = {'ended_at': (self.started + timedelta(seconds=2)).isoformat(), 'final_seq': 2, 'final_event_seq': 0}
        self.assertEqual(self.client.post(prefix + '/complete', json=final, headers=self.headers).status_code, 200)
        stats = self.client.get('/api/v1/statistics', query_string={
            'from': self.started.isoformat(), 'to': (self.started + timedelta(seconds=2)).isoformat(),
            'group_by': 'day', 'timezone': 'Asia/Seoul',
        }, headers=self.headers)
        self.assertEqual(stats.status_code, 200, stats.get_json())
        buckets = stats.get_json()['groups'][0]['buckets']
        self.assertEqual([b['metrics']['valid_duration_ms'] for b in buckets], [500, 1500])
        self.assertEqual([b['metrics']['normal_duration_ms'] for b in buckets], [500, 500])

    def test_cross_hour_correction_stays_with_its_original_alert(self):
        self.started = datetime(2026, 10, 17, 10, 59, 39, tzinfo=timezone.utc)
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        samples = [sample(seq, 35 if seq <= 20 else 10) for seq in range(1, 24)]
        received = self.client.post(prefix + '/samples:batch', json={'samples': samples}, headers=self.headers)
        self.assertEqual(received.status_code, 200, received.get_json())
        alert_id = str(uuid4())
        events = [
            {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 20000, 'type': 'alert_delivery',
             'data': {'alert_id': alert_id, 'stage': 1, 'channel': 'screen', 'result': 'delivered'}},
            {'event_id': str(uuid4()), 'event_seq': 2, 'elapsed_ms': 20100, 'type': 'alert_delivery',
             'data': {'alert_id': alert_id, 'stage': 1, 'channel': 'sound', 'result': 'delivered'}},
            {'event_id': str(uuid4()), 'event_seq': 3, 'elapsed_ms': 22000, 'type': 'correction_observed',
             'data': {'alert_id': alert_id, 'outcome': 'corrected'}},
        ]
        response = self.client.post(prefix + '/events:batch', json={'events': events}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        final = {'ended_at': (self.started + timedelta(seconds=23)).isoformat(), 'final_seq': 23, 'final_event_seq': 3}
        self.assertEqual(self.client.post(prefix + '/complete', json=final, headers=self.headers).status_code, 200)
        stats = self.client.get('/api/v1/statistics', query_string={
            'from': self.started.isoformat(), 'to': (self.started + timedelta(seconds=23)).isoformat(),
            'group_by': 'hour', 'timezone': 'UTC',
        }, headers=self.headers)
        self.assertEqual(stats.status_code, 200, stats.get_json())
        group = stats.get_json()['groups'][0]
        self.assertEqual(group['summary']['first_stage_alert_count'], 1)
        self.assertEqual(group['summary']['corrected_alert_count'], 1)
        self.assertEqual(group['summary']['mean_correction_ms'], 2000)
        self.assertEqual([b['metrics']['first_stage_alert_count'] for b in group['buckets']], [1, 0])
        self.assertEqual([b['metrics']['corrected_alert_count'] for b in group['buckets']], [1, 0])

    def test_event_pages_contain_all_items_once_when_timestamps_match(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        events = [{'event_id': str(uuid4()), 'event_seq': seq, 'elapsed_ms': 0, 'type': 'paused', 'data': {}}
                  for seq in range(1, 122)]
        for offset in range(0, len(events), 60):
            response = self.client.post(prefix + '/events:batch', json={'events': events[offset:offset+60]}, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.get_json())
        cursor, received = None, []
        for _ in range(7):
            params = {'limit': 25}
            if cursor:
                params['cursor'] = cursor
            response = self.client.get(prefix + '/events', query_string=params, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.get_json())
            self.assert_schema('EventPage', response.get_json())
            received.extend(item['event_id'] for item in response.get_json()['items'])
            cursor = response.get_json()['next_cursor']
            if cursor is None:
                break
        self.assertIsNone(cursor)
        self.assertEqual(received, sorted(event['event_id'] for event in events))
        self.assertEqual(len(received), len(set(received)))

    def test_statistics_skip_old_completed_sessions(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        received = self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10)]}, headers=self.headers)
        self.assertEqual(received.status_code, 200, received.get_json())
        final = {'ended_at': (self.started + timedelta(seconds=1)).isoformat(), 'final_seq': 1, 'final_event_seq': 0}
        self.assertEqual(self.client.post(prefix + '/complete', json=final, headers=self.headers).status_code, 200)
        repository = self.app.extensions['repository']
        with patch.object(repository, 'load', wraps=repository.load) as load:
            result = self.client.get('/api/v1/statistics', query_string={
                'from': (self.started + timedelta(days=1)).isoformat(),
                'to': (self.started + timedelta(days=2)).isoformat(), 'group_by': 'day', 'timezone': 'UTC',
            }, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        self.assertEqual(result.get_json()['groups'], [])
        self.assertEqual(load.call_count, 0)

    def test_statistics_only_recalculate_time_buckets_intersecting_a_session(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        received = self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10)]}, headers=self.headers)
        self.assertEqual(received.status_code, 200, received.get_json())
        final = {'ended_at': (self.started + timedelta(seconds=1)).isoformat(), 'final_seq': 1, 'final_event_seq': 0}
        self.assertEqual(self.client.post(prefix + '/complete', json=final, headers=self.headers).status_code, 200)
        with patch('ecolephant.routes.aggregate', wraps=aggregate_records) as aggregate_call:
            result = self.client.get('/api/v1/statistics', query_string={
                'from': (self.started - timedelta(days=15)).isoformat(),
                'to': (self.started + timedelta(days=15)).isoformat(), 'group_by': 'hour', 'timezone': 'UTC',
            }, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        self.assertEqual(result.get_json()['groups'][0]['summary']['valid_duration_ms'], 1000)
        scanned = sum(len(record['samples']) for call in aggregate_call.call_args_list for record in call.args[0])
        self.assertLessEqual(scanned, 3, f'Unrelated buckets repeatedly scanned {scanned} sample sets')

    def test_invalid_raw_data_rejects_the_whole_batch_without_echo(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        invalid = deepcopy(sample(2, 10))
        invalid['landmarks'] = [{'secret': 'private-image-payload'}]
        response = self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10), invalid]}, headers=self.headers)
        self.assertEqual(response.status_code, 422)
        self.assert_schema('Problem', response.get_json())
        self.assertNotIn('private-image-payload', response.get_data(as_text=True))
        detail = self.client.get(prefix, headers=self.headers).get_json()
        self.assertEqual(detail['acknowledged_through_seq'], 0)

    def test_owner_isolation_and_cors(self):
        health = self.client.get('/health')
        self.assertEqual(health.status_code, 200)
        self.assert_schema('Health', health.get_json())
        self.assertEqual(self.client.get('/api/v1/sessions').status_code, 401)
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        other = self.make_app('test-local-token-b').test_client()
        other_headers = {'Authorization': 'Bearer test-local-token-b'}
        self.assertEqual(other.get(prefix, headers=other_headers).status_code, 404)
        self.assertEqual(other.delete(prefix, headers=other_headers).status_code, 204)
        self.assertEqual(self.client.get(prefix, headers=self.headers).status_code, 200)
        allowed = self.client.options('/api/v1/sessions', headers={'Origin': 'http://127.0.0.1:5173'})
        self.assertEqual(allowed.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173')
        denied = self.client.options('/api/v1/sessions', headers={'Origin': 'https://untrusted.invalid'})
        self.assertNotIn('Access-Control-Allow-Origin', denied.headers)

    def test_out_of_order_unknown_windows_cannot_finish_until_gap_arrives(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        def batch(seq):
            return {'samples': [sample(seq, None, quality='no_sensor')]}
        received = self.client.post(prefix + '/samples:batch', json=batch(2), headers=self.headers)
        self.assertEqual(received.status_code, 200, received.get_json())
        self.assertEqual(received.get_json()['acknowledged_through_seq'], 0)
        end = (self.started + timedelta(seconds=2)).isoformat()
        final = {'ended_at': end, 'final_seq': 2, 'final_event_seq': 0}
        self.assertEqual(self.client.post(prefix + '/complete', json=final, headers=self.headers).status_code, 409)
        received = self.client.post(prefix + '/samples:batch', json=batch(1), headers=self.headers)
        self.assertEqual(received.get_json()['acknowledged_through_seq'], 2)
        finished = self.client.post(prefix + '/complete', json=final, headers=self.headers)
        self.assertEqual(finished.status_code, 200, finished.get_json())
        self.assertEqual(finished.get_json()['summaries'], [])
        self.assertEqual(finished.get_json()['unassigned_unknown_duration_ms'], 2000)
        timeline = self.client.get(prefix + '/timeline', headers=self.headers).get_json()
        self.assertEqual(timeline['buckets'][0]['unknown_ms'], 2000)

    def test_real_source_requires_approval_and_stays_separate_from_demo_statistics(self):
        payload = {
            'client_session_id': str(uuid4()), 'started_at': self.started.isoformat(),
            'requested_mode': 'webcam', 'policy_id': POLICY['policy_id'],
            'initial_calibration_epoch': 1, 'data_source': 'real',
        }
        headers = {**self.headers, 'Idempotency-Key': str(uuid4())}
        blocked = self.client.post('/api/v1/sessions', json=payload, headers=headers)
        self.assertEqual(blocked.status_code, 409, blocked.get_json())
        self.assertEqual(blocked.get_json()['code'], 'policy_not_approved')
        # These profiles are test doubles, not approval of the shipped draft.
        unvalidated, approved = deepcopy(POLICY), deepcopy(POLICY)
        unvalidated.update(policy_id='test-unvalidated', release_approved=True)
        approved.update(policy_id='test-approved', release_approved=True, camera_mapping_status='validated')
        keys = ('AUTH_MODE', 'LOCAL_TOKEN', 'STORAGE', 'DATABASE', 'TABLE', 'ENDPOINT', 'ALLOWED_ORIGIN')
        config = {key: self.app.config[key] for key in keys}
        config.update(TESTING=True, POLICIES=[POLICY, unvalidated, approved])
        self.app = create_app(config)
        self.client = self.app.test_client()
        payload['policy_id'] = unvalidated['policy_id']
        blocked = self.client.post('/api/v1/sessions', json=payload, headers=headers)
        self.assertEqual(blocked.status_code, 409, blocked.get_json())
        self.assertEqual(blocked.get_json()['code'], 'camera_mapping_unvalidated')
        airpods = {**payload, 'client_session_id': str(uuid4()), 'requested_mode': 'airpods'}
        airpods_headers = {**self.headers, 'Idempotency-Key': str(uuid4())}
        opened = self.client.post('/api/v1/sessions', json=airpods, headers=airpods_headers)
        self.assertEqual(opened.status_code, 201, opened.get_json())
        prefix = f"/api/v1/sessions/{opened.get_json()['id']}"
        blocked = self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10)]}, headers=self.headers)
        self.assertEqual(blocked.status_code, 409, blocked.get_json())
        self.assertEqual(blocked.get_json()['code'], 'camera_mapping_unvalidated')

        payload['policy_id'] = approved['policy_id']
        real = self.client.post('/api/v1/sessions', json=payload, headers=headers)
        self.assertEqual(real.status_code, 201, real.get_json())
        demo_payload = {**payload, 'client_session_id': str(uuid4()), 'data_source': 'demo'}
        demo_headers = {**self.headers, 'Idempotency-Key': str(uuid4())}
        demo = self.client.post('/api/v1/sessions', json=demo_payload, headers=demo_headers)
        self.assertEqual(demo.status_code, 201, demo.get_json())
        demo_id = demo.get_json()['id']
        for session_id in (real.get_json()['id'], demo_id):
            prefix = f'/api/v1/sessions/{session_id}'
            received = self.client.post(prefix + '/samples:batch', json={'samples': [sample(1, 10)]}, headers=self.headers)
            self.assertEqual(received.status_code, 200, received.get_json())
            final = {'ended_at': (self.started + timedelta(seconds=1)).isoformat(), 'final_seq': 1, 'final_event_seq': 0}
            self.assertEqual(self.client.post(prefix + '/complete', json=final, headers=self.headers).status_code, 200)
        stats = self.client.get('/api/v1/statistics', query_string={
            'from': self.started.isoformat(), 'to': (self.started + timedelta(days=1)).isoformat(),
            'group_by': 'day', 'timezone': 'UTC',
        }, headers=self.headers)
        self.assertEqual(stats.status_code, 200, stats.get_json())
        self.assert_schema('StatisticsResponse', stats.get_json())
        groups = {group['data_source']: group for group in stats.get_json()['groups']}
        self.assertEqual(set(groups), {'demo', 'real'})
        self.assertEqual(groups['demo']['summary']['valid_duration_ms'], 1000)
        self.assertEqual(groups['real']['summary']['valid_duration_ms'], 1000)
        self.assertEqual(groups['demo']['buckets'][0]['metrics']['valid_duration_ms'], 1000)
        self.assertEqual(groups['real']['buckets'][0]['metrics']['valid_duration_ms'], 1000)


if __name__ == '__main__':
    unittest.main()
