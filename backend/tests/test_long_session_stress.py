"""Opt-in eight-hour synthetic API exercise; no real sensor data or AWS account."""
from pathlib import Path
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant import create_app  # noqa: E402
from ecolephant.contracts import POLICY  # noqa: E402
from test_api_lifecycle import sample  # noqa: E402


@unittest.skipUnless(os.environ.get('ECOLEPHANT_LONG_SESSION_STRESS') == '1', 'Explicit long-session test not requested')
class LongSessionStressTests(unittest.TestCase):
    def test_eight_hours_of_batches_retries_and_alerts(self):
        temporary = tempfile.TemporaryDirectory(prefix='ecolephant-stress-')
        def cleanup():
            target = Path(temporary.name).resolve()
            if target.parent != Path(tempfile.gettempdir()).resolve():
                raise ValueError('Unexpected temporary test directory')
            temporary.cleanup()
        self.addCleanup(cleanup)
        app = create_app({'TESTING': True, 'AUTH_MODE': 'local', 'LOCAL_TOKEN': 'synthetic-stress-token',
                          'STORAGE': 'sqlite', 'DATABASE': str(Path(temporary.name) / 'test.sqlite3'),
                          'ALLOWED_ORIGIN': 'http://127.0.0.1:5173'})
        client, repository = app.test_client(), app.extensions['repository']
        headers = {'Authorization': 'Bearer synthetic-stress-token'}
        payload = {'client_session_id': str(uuid4()), 'started_at': '2026-10-17T10:00:00Z',
                   'requested_mode': 'webcam', 'policy_id': POLICY['policy_id'],
                   'initial_calibration_epoch': 1, 'data_source': 'demo'}
        created = client.post('/api/v1/sessions', json=payload,
                              headers={**headers, 'Idempotency-Key': str(uuid4())})
        self.assertEqual(created.status_code, 201, created.get_json())
        session_id = created.get_json()['id']
        prefix = f'/api/v1/sessions/{session_id}'
        event_seq, high_count, elapsed_start = 0, 0, time.perf_counter()
        with patch.object(repository, 'load', wraps=repository.load) as full_load:
            for last in range(5, 28801, 5):
                batch = []
                for seq in range(last - 4, last + 1):
                    high = seq % 40 < 10
                    high_count += int(high)
                    batch.append(sample(seq, 35 if high else 10))
                response = client.post(prefix + '/samples:batch', json={'samples': batch}, headers=headers)
                self.assertEqual(response.status_code, 200, response.get_json())
                self.assertEqual(response.get_json()['acknowledged_through_seq'], last)
                if last in (3600, 14400):
                    retry = client.post(prefix + '/samples:batch', json={'samples': batch}, headers=headers)
                    self.assertEqual(retry.get_json()['duplicate_count'], 5)
                if last % 1800 == 0:
                    alert_id, occurred = str(uuid4()), last * 1000 - 500
                    events = [
                        {'event_id': str(uuid4()), 'event_seq': event_seq + 1, 'elapsed_ms': occurred,
                         'type': 'alert_delivery', 'data': {'alert_id': alert_id, 'stage': 1,
                                                            'channel': 'screen', 'result': 'delivered'}},
                        {'event_id': str(uuid4()), 'event_seq': event_seq + 2, 'elapsed_ms': occurred + 100,
                         'type': 'correction_observed', 'data': {'alert_id': alert_id, 'outcome': 'corrected'}},
                    ]
                    received = client.post(prefix + '/events:batch', json={'events': events}, headers=headers)
                    self.assertEqual(received.status_code, 200, received.get_json())
                    event_seq += 2
            self.assertLessEqual(full_load.call_count, 20)
        final = {'ended_at': '2026-10-17T18:00:00Z', 'final_seq': 28800, 'final_event_seq': event_seq}
        complete = client.post(prefix + '/complete', json=final, headers=headers)
        self.assertEqual(complete.status_code, 200, complete.get_json())
        metrics = complete.get_json()['summaries'][0]['metrics']
        self.assertEqual(metrics['valid_duration_ms'], 28800000)
        self.assertEqual(metrics['high_duration_ms'], high_count * 1000)
        self.assertEqual(metrics['normal_duration_ms'], (28800 - high_count) * 1000)
        self.assertEqual((metrics['first_stage_alert_count'], metrics['corrected_alert_count']), (16, 16))
        self.assertAlmostEqual(metrics['mean_display_angle_deg'], (35 * high_count + 10 * (28800 - high_count)) / 28800)
        with repository.connection() as connection:
            count = connection.execute('SELECT COUNT(*) FROM timeline_buckets WHERE session_id=?', (session_id,)).fetchone()[0]
        self.assertEqual(count, 480)
        with patch.object(repository, 'load', side_effect=AssertionError('Long timeline read all samples')):
            timeline = client.get(prefix + '/timeline', query_string={'from_elapsed_ms': 21600000,
                                  'to_elapsed_ms': 28800000}, headers=headers)
        self.assertEqual(timeline.status_code, 200, timeline.get_json())
        buckets = timeline.get_json()['buckets']
        self.assertEqual(len(buckets), 120)
        self.assertEqual(sum(bucket['high_ms'] for bucket in buckets), 1800000)
        self.assertEqual(sum(bucket['normal_ms'] for bucket in buckets), 5400000)
        print(f'  Synthetic 8-hour session: {time.perf_counter() - elapsed_start:.1f}s, {full_load.call_count} full reads')


if __name__ == '__main__':
    unittest.main()
