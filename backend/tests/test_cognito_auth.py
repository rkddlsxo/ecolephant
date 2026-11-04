"""Exercise JWT validation locally with ephemeral keys and no AWS access."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from uuid import uuid4

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant import create_app  # noqa: E402
from ecolephant.contracts import POLICY  # noqa: E402


class CognitoAuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.signing_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ecolephant-auth-')
        self.addCleanup(self.temp.cleanup)
        self.issuer = 'https://cognito-idp.ap-northeast-2.amazonaws.com/example-pool'
        self.client_id = 'example-client'
        self.app = create_app({
            'TESTING': True,
            'AUTH_MODE': 'cognito',
            'JWT_ISSUER': self.issuer,
            'JWT_CLIENT_ID': self.client_id,
            'STORAGE': 'sqlite',
            'DATABASE': str(Path(self.temp.name) / 'test.sqlite3'),
        })
        key = SimpleNamespace(key=self.signing_key.public_key())
        self.app.extensions['jwks'] = SimpleNamespace(get_signing_key_from_jwt=lambda token: key)
        self.client = self.app.test_client()
        self.now = datetime.now(timezone.utc)

    def token(self, owner='owner-a', *, token_use='access', key=None, **claims):
        body = {
            'iss': self.issuer, 'sub': owner, 'iat': self.now,
            'exp': self.now + timedelta(minutes=5), 'token_use': token_use,
            **({'client_id': self.client_id} if token_use == 'access' else {'aud': self.client_id}),
            **claims,
        }
        return jwt.encode(body, key or self.signing_key, algorithm='RS256')

    @staticmethod
    def headers(token):
        return {'Authorization': f'Bearer {token}'}

    def test_valid_access_and_id_tokens_and_rejected_invalid_tokens(self):
        for token in (self.token(), self.token(token_use='id')):
            with self.subTest(kind='valid'):
                self.assertEqual(self.client.get('/api/v1/policies', headers=self.headers(token)).status_code, 200)
        invalid = [
            self.token(client_id='other-client'),
            self.token(token_use='id', aud='other-client'),
            self.token(iss='https://not-the-user-pool.invalid'),
            self.token(exp=self.now - timedelta(minutes=1)),
            self.token(token_use='refresh'),
            self.token(key=self.other_key),
            'not-a-jwt',
        ]
        for token in invalid:
            with self.subTest(kind='invalid'):
                response = self.client.get('/api/v1/policies', headers=self.headers(token))
                self.assertEqual(response.status_code, 401, response.get_json())
                self.assertNotIn(token, response.get_data(as_text=True))

    def test_cognito_subject_owns_its_records(self):
        alice = self.headers(self.token(owner='owner-a'))
        bob = self.headers(self.token(owner='owner-b'))
        payload = {
            'client_session_id': str(uuid4()), 'started_at': self.now.isoformat(timespec='milliseconds'),
            'requested_mode': 'webcam', 'policy_id': POLICY['policy_id'],
            'initial_calibration_epoch': 1, 'data_source': 'demo',
        }
        created = self.client.post('/api/v1/sessions', json=payload, headers={
            **alice, 'Idempotency-Key': str(uuid4()),
        })
        self.assertEqual(created.status_code, 201, created.get_json())
        path = f"/api/v1/sessions/{created.get_json()['id']}"
        self.assertEqual(self.client.get(path, headers=bob).status_code, 404)
        self.assertEqual(self.client.delete(path, headers=bob).status_code, 204)
        self.assertEqual(self.client.get(path, headers=alice).status_code, 200)


if __name__ == '__main__':
    unittest.main()
