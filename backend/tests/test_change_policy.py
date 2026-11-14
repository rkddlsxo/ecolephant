"""Change-based webcam judgement (draft-web-v1, DEC-002) with synthetic data only."""

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import json
import sys
import tempfile
import unittest
from uuid import uuid4

from jsonschema import Draft202012Validator, FormatChecker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant import create_app, policies  # noqa: E402
from ecolephant.contracts import BASE, POLICY, SPEC  # noqa: E402
from ecolephant.metrics import aggregate  # noqa: E402

V1 = json.loads((BASE / 'policies' / 'draft-web-v1.json').read_text(encoding='utf-8'))
V2 = json.loads((BASE / 'policies' / 'draft-web-v2.json').read_text(encoding='utf-8'))


def window(seq, *, mode='webcam', forward=0.0, drop=0.0, nose=None, head=None, level='normal',
           reason='within_range', posture=None, quality='valid'):
    valid = quality == 'valid'
    camera = valid and mode in {'webcam', 'combined'}
    return {
        'seq': seq, 'elapsed_start_ms': (seq - 1) * 1000, 'duration_ms': 1000, 'calibration_epoch': 1,
        'active_mode': mode if valid else 'none', 'quality': quality,
        'camera_estimate_deg': None, 'head_flexion_deg': head if valid else None,
        'display_angle_deg': head if valid else None,
        'posture_level': level if valid else 'unknown',
        'reason_code': reason if valid else 'insufficient_data',
        'confidence': ('dual_sensor' if mode == 'combined' else 'single_sensor') if valid else 'unavailable',
        'camera_forward_change': forward if camera else None,
        'camera_drop_change': drop if camera else None,
        'camera_nose_drop_change': nose if camera else None,
        'posture_type': posture if valid else None,
    }


class ChangePolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ecolephant-change-')
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name) / 'test.sqlite3'
        self.headers = {'Authorization': 'Bearer test-local-token-a'}
        self.started = datetime(2026, 11, 10, 10, tzinfo=timezone.utc)
        self.restart()

    def restart(self, profiles=None):
        config = {'TESTING': True, 'AUTH_MODE': 'local', 'LOCAL_TOKEN': 'test-local-token-a',
                  'STORAGE': 'sqlite', 'DATABASE': str(self.database),
                  'ALLOWED_ORIGIN': 'http://127.0.0.1:5173'}
        if profiles is not None:
            config['POLICIES'] = profiles
        self.app = create_app(config)
        self.client = self.app.test_client()

    def assert_schema(self, name, value):
        schema = {'$ref': f'#/components/schemas/{name}', 'components': SPEC['components']}
        errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value))
        self.assertEqual([(list(e.absolute_path), e.message) for e in errors], [])

    def open(self, policy_id=V1['policy_id'], mode='webcam', source='demo'):
        payload = {'client_session_id': str(uuid4()), 'started_at': self.started.isoformat(),
                   'requested_mode': mode, 'policy_id': policy_id,
                   'initial_calibration_epoch': 1, 'data_source': source}
        headers = {**self.headers, 'Idempotency-Key': str(uuid4())}
        return self.client.post('/api/v1/sessions', json=payload, headers=headers)

    def post(self, session_id, samples):
        return self.client.post(f'/api/v1/sessions/{session_id}/samples:batch',
                                json={'samples': samples}, headers=self.headers)

    def test_packaged_catalog_serves_both_angle_and_change_profiles(self):
        catalog = policies.load_catalog()
        self.assertEqual(set(catalog), {POLICY['policy_id'], V1['policy_id'], V2['policy_id']})
        for profile in (V1, V2):
            self.assertEqual(profile['camera_judgement'], 'change')
            self.assertFalse(profile['release_approved'])
            self.assertEqual(profile['camera_mapping_status'], 'unvalidated')
        # Policy contents are immutable per ID, so changed thresholds need a new ID.
        self.assertNotEqual(V1['camera_change_thresholds'], V2['camera_change_thresholds'])

    def test_change_windows_are_accepted_and_statistics_skip_missing_angles(self):
        opened = self.open()
        self.assertEqual(opened.status_code, 201, opened.get_json())
        session_id = opened.get_json()['id']
        samples = [
            window(1),
            window(2, forward=0.25, drop=-0.02, level='high', reason='forward_shift', posture='chin_forward'),
            window(3, forward=0.0, drop=-0.04, nose=-0.15, level='caution', reason='head_flexion',
                   posture='head_down'),
            window(4, quality='motion') | {'reason_code': 'motion', 'active_mode': 'webcam'},
        ]
        for item in samples:
            self.assert_schema('SampleWindow', item)
        received = self.post(session_id, samples)
        self.assertEqual(received.status_code, 200, received.get_json())
        session = self.client.get(f'/api/v1/sessions/{session_id}', headers=self.headers).get_json()
        self.assert_schema('Session', session)
        metrics = session['summaries'][0]['metrics']
        self.assertEqual(metrics['valid_duration_ms'], 3000)
        self.assertEqual(metrics['high_duration_ms'], 1000)
        self.assertEqual(metrics['forward_head_suspected_ms'], 1000)
        self.assertIsNone(metrics['mean_display_angle_deg'])
        self.assertAlmostEqual(metrics['within_range_percent'], 100 / 3)

    def test_server_rechecks_change_judgements(self):
        session_id = self.open().get_json()['id']
        cases = {
            'decision_mismatch': window(1, forward=0.25, level='high', reason='forward_shift', posture='combined'),
            'camera_change_missing': window(1, level='normal') | {'camera_forward_change': None},
            'camera_angle_unvalidated': window(1) | {'camera_estimate_deg': 12},
            'angle_mismatch': window(1) | {'display_angle_deg': 12},
        }
        for code, item in cases.items():
            with self.subTest(code=code):
                response = self.post(session_id, [item])
                self.assertEqual(response.status_code, 422, response.get_json())
                self.assertEqual(response.get_json()['code'], code)

    def test_combined_uses_airpods_for_the_drop_and_reports_only_measured_degrees(self):
        session_id = self.open(mode='combined').get_json()['id']
        samples = [
            # Webcam ears dropped, AirPods level → forward part decides.
            window(1, mode='combined', forward=0.22, drop=-0.3, head=5, level='high',
                   reason='forward_shift', posture='chin_forward'),
            window(2, mode='combined', forward=0.02, drop=0.0, head=20, level='caution',
                   reason='head_flexion', posture='head_down'),
        ]
        received = self.post(session_id, samples)
        self.assertEqual(received.status_code, 200, received.get_json())
        session = self.client.get(f'/api/v1/sessions/{session_id}', headers=self.headers).get_json()
        self.assertAlmostEqual(session['summaries'][0]['metrics']['mean_display_angle_deg'], 12.5)

    def test_angle_policy_still_requires_degrees(self):
        session_id = self.open(policy_id=POLICY['policy_id']).get_json()['id']
        response = self.post(session_id, [window(1)])
        self.assertEqual(response.status_code, 422, response.get_json())
        self.assertEqual(response.get_json()['code'], 'angle_missing')

    def test_real_change_sessions_need_team_approval_but_no_angle_mapping(self):
        blocked = self.open(source='real')
        self.assertEqual(blocked.status_code, 409, blocked.get_json())
        self.assertEqual(blocked.get_json()['code'], 'policy_not_approved')
        # Test double: what the team approval would look like. Not approval of the shipped draft.
        approved = deepcopy(V1)
        approved.update(policy_id='test-change-approved', release_approved=True)
        self.restart([POLICY, V1, approved])
        opened = self.open(policy_id='test-change-approved', source='real')
        self.assertEqual(opened.status_code, 201, opened.get_json())
        received = self.post(opened.get_json()['id'], [window(1)])
        self.assertEqual(received.status_code, 200, received.get_json())

    def test_incremental_summaries_match_full_recalculation(self):
        session_id = self.open(mode='combined').get_json()['id']
        batches = [
            [window(1), window(2, forward=0.12, drop=-0.12, level='caution', reason='mixed_caution',
                               posture='combined')],
            [window(3, mode='combined', forward=0.0, drop=0.0, head=31, level='high',
                    reason='head_flexion', posture='head_down')],
        ]
        for batch in batches:
            self.assertEqual(self.post(session_id, batch).status_code, 200)
        stored = self.client.get(f'/api/v1/sessions/{session_id}', headers=self.headers).get_json()['summaries']
        record = {'session': {'policy_id': V1['policy_id'], 'started_at': self.started.isoformat()},
                  'samples': {item['seq']: item for batch in batches for item in batch}, 'events': {}}
        rebuilt, _ = aggregate([record])
        self.assertEqual(stored, rebuilt)

    def test_invalid_change_profiles_fail_before_serving(self):
        broken = deepcopy(V1)
        broken['camera_change_thresholds']['drop'] = {'caution': -0.2, 'high': -0.1}
        with self.assertRaises(ValueError):
            policies.load_catalog([broken])
        missing = deepcopy(V1)
        del missing['camera_change_thresholds']
        with self.assertRaises(ValueError):
            policies.load_catalog([missing])


if __name__ == '__main__':
    unittest.main()
