"""Synthetic policy versions must never reinterpret saved measurements."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import timedelta
import json
from pathlib import Path
import tempfile
from unittest.mock import patch
from uuid import uuid4

import test_api_lifecycle as lifecycle
import test_dynamodb_local as dynamo
from ecolephant import create_app
from ecolephant.contracts import POLICY, iso
from ecolephant.errors import ApiError


def policy(name, *, high=30, caution=15, weights=(0.5, 0.5), second_after=30000):
    result = deepcopy(POLICY)
    result['policy_id'] = name
    result['thresholds_deg'] = {'caution': caution, 'high': high}
    result['fusion_weights'] = {'webcam': weights[0], 'airpods': weights[1]}
    result['alerts']['second_after_first_ms'] = second_after
    return result


class PolicyScenarios:
    def restart_with(self, profiles):
        keys = ('AUTH_MODE', 'LOCAL_TOKEN', 'STORAGE', 'DATABASE', 'TABLE', 'ENDPOINT', 'ALLOWED_ORIGIN')
        config = {key: self.app.config[key] for key in keys}
        config.update(TESTING=True, POLICIES=profiles)
        self.app = create_app(config)
        self.client = self.app.test_client()

    def open_for(self, policy_id):
        payload = {'client_session_id': str(uuid4()), 'started_at': self.started.isoformat(),
                   'requested_mode': 'webcam', 'policy_id': policy_id,
                   'initial_calibration_epoch': 1, 'data_source': 'demo'}
        headers = {**self.headers, 'Idempotency-Key': str(uuid4())}
        response = self.client.post('/api/v1/sessions', json=payload, headers=headers)
        return response, payload, headers

    def test_versions_apply_their_own_thresholds_weights_alerts_and_statistics(self):
        first = policy('test-a')
        second = policy('test-b', caution=5, high=10, weights=(0.25, 0.75), second_after=10000)
        self.restart_with([first, second])
        listed = self.client.get('/api/v1/policies', headers=self.headers)
        self.assertEqual({x['policy_id'] for x in listed.get_json()['items']}, {'test-a', 'test-b'})
        for profile in (first, second):
            response, _, _ = self.open_for(profile['policy_id'])
            self.assertEqual(response.status_code, 201, response.get_json())
            prefix = '/api/v1/sessions/' + response.get_json()['id']
            item = lifecycle.sample(1, 10)
            if profile is second:
                item.update(posture_level='high', reason_code='forward_shift')
            result = self.client.post(prefix + '/samples:batch', json={'samples': [item]}, headers=self.headers)
            self.assertEqual(result.status_code, 200, result.get_json())
            final = {'ended_at': (self.started + timedelta(seconds=1)).isoformat(), 'final_seq': 1, 'final_event_seq': 0}
            self.assertEqual(self.client.post(prefix + '/complete', json=final, headers=self.headers).status_code, 200)
        stats = self.client.get('/api/v1/statistics', query_string={
            'from': self.started.isoformat(), 'to': (self.started + timedelta(days=1)).isoformat(),
            'group_by': 'day', 'timezone': 'UTC',
        }, headers=self.headers)
        self.assertEqual({g['policy_id'] for g in stats.get_json()['groups']}, {'test-a', 'test-b'})
        response, _, _ = self.open_for('test-b')
        prefix = '/api/v1/sessions/' + response.get_json()['id']
        combined = lifecycle.sample(1, 10)
        combined.update(active_mode='combined', head_flexion_deg=20, display_angle_deg=17.5,
                        posture_level='high', reason_code='combined_high', confidence='dual_sensor')
        result = self.client.post(prefix + '/samples:batch', json={'samples': [combined]}, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        alert_id = str(uuid4())
        def delivery(seq, elapsed, stage):
            return {'event_id': str(uuid4()), 'event_seq': seq, 'elapsed_ms': elapsed, 'type': 'alert_delivery',
                    'data': {'alert_id': alert_id, 'stage': stage, 'channel': 'screen', 'result': 'delivered'}}
        events = [delivery(1, 0, 1), delivery(2, 9999, 2)]
        result = self.client.post(prefix + '/events:batch', json={'events': events}, headers=self.headers)
        self.assertEqual(result.status_code, 409, result.get_json())
        events[1]['elapsed_ms'] = 10000
        result = self.client.post(prefix + '/events:batch', json={'events': events}, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())

    def test_redefined_id_fails_and_existing_session_and_retry_survive_deployment(self):
        original = policy('test-a')
        self.restart_with([original])
        created, payload, headers = self.open_for('test-a')
        self.assertEqual(created.status_code, 201, created.get_json())
        session_id = created.get_json()['id']
        changed = policy('test-a', caution=5, high=10)
        self.restart_with([changed, policy('test-b')])
        denied, _, _ = self.open_for('test-a')
        self.assertEqual(denied.status_code, 409, denied.get_json())
        self.assertEqual(denied.get_json()['code'], 'policy_id_conflict')
        result = self.client.post(f'/api/v1/sessions/{session_id}/samples:batch',
                                  json={'samples': [lifecycle.sample(1, 10)]}, headers=self.headers)
        self.assertEqual(result.status_code, 200, result.get_json())
        self.restart_with([policy('test-b')])
        retry = self.client.post('/api/v1/sessions', json=payload, headers=headers)
        self.assertEqual(retry.status_code, 201, retry.get_json())
        self.assertEqual(retry.get_json()['id'], session_id)
        new, _, _ = self.open_for('test-a')
        self.assertEqual(new.status_code, 404)

    def test_legacy_draft_session_without_snapshot_retains_known_original_policy(self):
        owner = 'legacy-owner'
        repository = self.app.extensions['repository']
        session_id, client_id, key = str(uuid4()), str(uuid4()), str(uuid4())
        payload = {'client_session_id': client_id, 'started_at': iso(self.started), 'requested_mode': 'webcam',
                   'policy_id': POLICY['policy_id'], 'initial_calibration_epoch': 1, 'data_source': 'demo'}
        session = {'id': session_id, **{k: payload[k] for k in ('client_session_id', 'started_at', 'requested_mode', 'policy_id', 'data_source')},
                   'ended_at': None, 'status': 'active', 'final_seq': None, 'final_event_seq': None,
                   'acknowledged_through_seq': 0, 'acknowledged_through_event_seq': 0,
                   'summaries': [], 'unassigned_unknown_duration_ms': 0}
        repository.create(owner, key, payload, {'session': session, 'create': payload, 'revision': 0})
        from ecolephant import service
        record = repository.load(owner, session_id)
        self.assertNotIn('policy', record)
        result = service.ingest(repository, owner, session_id, 'samples', [lifecycle.sample(1, 10)])
        self.assertEqual(result['accepted_count'], 1)
        changed = deepcopy(POLICY)
        changed['thresholds_deg']['high'] = 20
        self.restart_with([changed])
        denied, _, _ = self.open_for(POLICY['policy_id'])
        self.assertEqual(denied.status_code, 409, denied.get_json())
        self.assertEqual(denied.get_json()['code'], 'policy_id_conflict')

    def test_invalid_and_duplicate_profiles_fail_before_serving(self):
        a = policy('test-a')
        invalid = policy('test-b', caution=30, high=10)
        with self.assertRaises(ValueError):
            self.restart_with([a, invalid])
        with self.assertRaises(ValueError):
            self.restart_with([a, deepcopy(a)])
        invalid = policy('test-b', weights=(0.2, 0.2))
        with self.assertRaises(ValueError):
            self.restart_with([a, invalid])

    def test_packaged_extra_profiles_are_loaded_and_missing_snapshots_fail_closed(self):
        from ecolephant import policies
        with tempfile.TemporaryDirectory(prefix='ecolephant-policies-') as directory:
            root = Path(directory)
            (root / 'policies').mkdir()
            (root / 'policies' / 'example.json').write_text(json.dumps(policy('test-extra')), encoding='utf-8')
            with patch.object(policies, 'BASE', root):
                loaded = policies.load_catalog()
        self.assertEqual(set(loaded), {POLICY['policy_id'], 'test-extra'})
        with self.assertRaises(ApiError) as caught:
            policies.session_policy({'session': {'policy_id': 'test-extra'}})
        self.assertEqual(caught.exception.code, 'policy_snapshot_missing')

    def test_concurrent_same_id_different_content_cannot_both_register(self):
        repository = self.app.extensions['repository']
        candidates = [policy('race-id'), policy('race-id', caution=5, high=10)]
        def register(profile):
            try:
                repository.ensure_policy(profile)
                return 'ok'
            except ApiError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(register, candidates))
        self.assertEqual(sorted(outcomes), ['ok', 'policy_id_conflict'])


class PolicySQLiteTests(PolicyScenarios, lifecycle.ApiLifecycleTests):
    pass


class PolicyDynamoTests(PolicyScenarios, dynamo.DynamoLifecycleTests):
    pass
