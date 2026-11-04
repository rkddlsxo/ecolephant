"""Verify local defaults without reading a developer's environment file."""

from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant import create_app  # noqa: E402


class DevelopmentDefaultsTests(unittest.TestCase):
    def test_default_origin_matches_the_documented_development_screen(self):
        temporary = tempfile.TemporaryDirectory(prefix='ecolephant-default-test-')
        try:
            with patch('ecolephant.load_dotenv'), patch.dict(os.environ, {}, clear=False):
                os.environ.pop('ECOLEPHANT_ALLOWED_ORIGIN', None)
                app = create_app({'TESTING': True, 'AUTH_MODE': 'local', 'LOCAL_TOKEN': 'synthetic',
                                  'STORAGE': 'sqlite', 'DATABASE': str(Path(temporary.name) / 'test.sqlite3')})
                response = app.test_client().options('/api/v1/sessions', headers={
                    'Origin': 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST',
                })
        finally:
            target = Path(temporary.name).resolve()
            if target.parent != Path(tempfile.gettempdir()).resolve() or not target.name.startswith('ecolephant-default-test-'):
                raise ValueError('Unexpected temporary test directory')
            temporary.cleanup()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173')
