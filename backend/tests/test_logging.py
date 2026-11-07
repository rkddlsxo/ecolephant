"""Verify structured JSON logging and privacy boundaries on request logs."""

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant import create_app  # noqa: E402
from ecolephant.contracts import POLICY  # noqa: E402


class StructuredLoggingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ecolephant-log-test-')
        self.addCleanup(self.cleanup_temp)
        self.token = 'secret-local-bearer-token-999'
        self.app = create_app({
            'TESTING': True,
            'AUTH_MODE': 'local',
            'LOCAL_TOKEN': self.token,
            'STORAGE': 'sqlite',
            'DATABASE': str(Path(self.temp.name) / 'test.sqlite3'),
            'ALLOWED_ORIGIN': 'http://127.0.0.1:5173',
        })
        self.client = self.app.test_client()
        self.headers = {'Authorization': f'Bearer {self.token}'}

    def cleanup_temp(self):
        target = Path(self.temp.name).resolve()
        if target.parent != Path(tempfile.gettempdir()).resolve():
            raise ValueError('Unexpected temporary test directory')
        self.temp.cleanup()

    def test_structured_json_log_contains_observability_fields_and_hashes_owner(self):
        with self.assertLogs(self.app.logger, level='INFO') as captured:
            health = self.client.get('/health')
            payload = {
                'client_session_id': str(uuid4()),
                'started_at': datetime(2026, 10, 17, 10, tzinfo=timezone.utc).isoformat(),
                'requested_mode': 'webcam',
                'policy_id': POLICY['policy_id'],
                'initial_calibration_epoch': 1,
                'data_source': 'demo',
            }
            created = self.client.post(
                '/api/v1/sessions',
                json=payload,
                headers={**self.headers, 'Idempotency-Key': str(uuid4())},
            )

        self.assertEqual(health.status_code, 200)
        self.assertEqual(created.status_code, 201)
        self.assertEqual(len(captured.records), 2)

        health_log = json.loads(captured.records[0].getMessage())
        self.assertEqual(health_log['request_id'], health.headers['X-Request-ID'])
        self.assertEqual(health_log['method'], 'GET')
        self.assertEqual(health_log['path'], '/health')
        self.assertEqual(health_log['status'], 200)
        self.assertGreaterEqual(health_log['latency_ms'], 0.0)
        self.assertIsNone(health_log['owner_hash'])
        self.assertIsNone(health_log['error_code'])

        expected_owner = 'local-' + hashlib.sha256(self.token.encode()).hexdigest()[:24]
        expected_owner_hash = hashlib.sha256(expected_owner.encode()).hexdigest()[:12]

        session_log = json.loads(captured.records[1].getMessage())
        self.assertEqual(session_log['request_id'], created.headers['X-Request-ID'])
        self.assertEqual(session_log['method'], 'POST')
        self.assertEqual(session_log['path'], '/api/v1/sessions')
        self.assertEqual(session_log['status'], 201)
        self.assertEqual(session_log['owner_hash'], expected_owner_hash)
        self.assertIsNone(session_log['error_code'])

    def test_structured_json_log_never_leaks_tokens_landmarks_frames_or_raw_imu(self):
        payload = {
            'client_session_id': str(uuid4()),
            'started_at': datetime(2026, 10, 17, 10, tzinfo=timezone.utc).isoformat(),
            'requested_mode': 'webcam',
            'policy_id': POLICY['policy_id'],
            'initial_calibration_epoch': 1,
            'data_source': 'demo',
            'frame': 'raw-camera-frame-bytes-xyz',
            'landmarks': [{'x': 0.51, 'y': 0.42, 'secret': 'sensitive-pose-coord'}],
            'raw_imu': {'pitch': 12.34, 'roll': -4.56, 'secret': 'raw-motion-stream'},
        }
        with self.assertLogs(self.app.logger, level='INFO') as captured:
            response = self.client.post(
                '/api/v1/sessions?token=query-secret-999',
                json=payload,
                headers={**self.headers, 'Idempotency-Key': str(uuid4())},
            )

        self.assertEqual(response.status_code, 422)
        raw_output = '\n'.join(record.getMessage() for record in captured.records)
        for forbidden in (
            self.token,
            'query-secret-999',
            'raw-camera-frame-bytes-xyz',
            'sensitive-pose-coord',
            'raw-motion-stream',
            'landmarks',
            'raw_imu',
        ):
            self.assertNotIn(forbidden, raw_output)

        error_log = json.loads(captured.records[0].getMessage())
        self.assertEqual(error_log['status'], 422)
        self.assertEqual(error_log['path'], '/api/v1/sessions')
        self.assertEqual(error_log['error_code'], 'invalid_request')
        self.assertIsNotNone(error_log['owner_hash'])


if __name__ == '__main__':
    unittest.main()

