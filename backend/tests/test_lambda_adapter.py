"""Exercise the real Lambda entry point with synthetic HTTP API v2 events."""

import base64
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant import create_app  # noqa: E402
from ecolephant.contracts import POLICY  # noqa: E402


class LambdaAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='ecolephant-lambda-')
        self.addCleanup(temporary.cleanup)
        self.issuer = 'https://cognito-idp.ap-northeast-2.amazonaws.com/example-pool'
        app = create_app({'TESTING': True, 'AUTH_MODE': 'cognito', 'JWT_ISSUER': self.issuer,
                          'JWT_CLIENT_ID': 'example-client', 'STORAGE': 'sqlite',
                          'DATABASE': str(Path(temporary.name) / 'lambda.sqlite3'),
                          'ALLOWED_ORIGIN': 'https://frontend.example.test'})
        app.extensions['jwks'] = SimpleNamespace(get_signing_key_from_jwt=lambda _: SimpleNamespace(key=self.key.public_key()))
        path = Path(__file__).resolve().parents[1] / 'lambda_handler.py'
        spec = importlib.util.spec_from_file_location('synthetic_lambda_entry', path)
        module = importlib.util.module_from_spec(spec)
        with patch('ecolephant.create_app', return_value=app):
            spec.loader.exec_module(module)
        self.handler = module.handler

    def token(self, subject):
        now = datetime.now(timezone.utc)
        return jwt.encode({'iss': self.issuer, 'sub': subject, 'iat': now,
                           'exp': now + timedelta(minutes=5), 'token_use': 'access',
                           'client_id': 'example-client'}, self.key, algorithm='RS256')

    def event(self, method, path, *, body=None, headers=None, encoded=False):
        event = {'version': '2.0', 'routeKey': '$default', 'rawPath': path, 'rawQueryString': '',
                 'headers': {'host': 'api.example.test', 'x-forwarded-proto': 'https', **(headers or {})},
                 'requestContext': {'http': {'method': method, 'path': path, 'protocol': 'HTTP/1.1',
                                              'sourceIp': '127.0.0.1'}}, 'isBase64Encoded': encoded}
        if body is not None:
            text = json.dumps(body)
            event['headers']['content-type'] = 'application/json'
            event['body'] = base64.b64encode(text.encode()).decode() if encoded else text
        return event

    def test_health_and_untrusted_authorizer_context(self):
        health = self.handler(self.event('GET', '/health'), None)
        self.assertEqual(health['statusCode'], 200)
        self.assertEqual(json.loads(health['body'])['status'], 'ok')
        event = self.event('GET', '/api/v1/sessions')
        event['requestContext']['authorizer'] = {'jwt': {'claims': {'sub': 'pretend-owner'}}}
        denied = self.handler(event, None)
        self.assertEqual(denied['statusCode'], 401)

    def test_authenticated_create_and_owner_isolation_with_encoded_body(self):
        headers = {'authorization': 'Bearer ' + self.token('owner-a'), 'idempotency-key': str(uuid4()),
                   'origin': 'https://frontend.example.test'}
        payload = {'client_session_id': str(uuid4()), 'started_at': '2026-10-17T10:00:00Z',
                   'requested_mode': 'webcam', 'policy_id': POLICY['policy_id'],
                   'initial_calibration_epoch': 1, 'data_source': 'demo'}
        created = self.handler(self.event('POST', '/api/v1/sessions', body=payload, headers=headers, encoded=True), None)
        self.assertEqual(created['statusCode'], 201, created)
        self.assertEqual(created['headers'].get('access-control-allow-origin'), 'https://frontend.example.test')
        session_id = json.loads(created['body'])['id']
        other = {'authorization': 'Bearer ' + self.token('owner-b')}
        result = self.handler(self.event('GET', '/api/v1/sessions/' + session_id, headers=other), None)
        self.assertEqual(result['statusCode'], 404)
        own = self.handler(self.event('GET', '/api/v1/sessions/' + session_id, headers=headers), None)
        self.assertEqual(own['statusCode'], 200)

    def test_raw_image_payload_is_rejected_without_echo(self):
        headers = {'authorization': 'Bearer ' + self.token('owner-a'), 'idempotency-key': str(uuid4())}
        payload = {'client_session_id': str(uuid4()), 'started_at': '2026-10-17T10:00:00Z',
                   'requested_mode': 'webcam', 'policy_id': POLICY['policy_id'],
                   'initial_calibration_epoch': 1, 'image': 'private-raw-marker'}
        response = self.handler(self.event('POST', '/api/v1/sessions', body=payload, headers=headers), None)
        self.assertEqual(response['statusCode'], 422)
        self.assertNotIn('private-raw-marker', response['body'])
