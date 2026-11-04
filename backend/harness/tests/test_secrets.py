from pathlib import Path
import importlib
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
findings = importlib.import_module("checks.secrets").findings


class SecretsChecks(unittest.TestCase):
    def test_recognizes_token_without_echoing_value(self):
        token='ghp_'+'A'*36
        self.assertEqual(findings('first line\n'+token),[2])

    def test_recognizes_private_key_header(self):
        self.assertEqual(findings('-----BEGIN '+'PRIVATE KEY-----'),[1])

    def test_synthetic_pairing_label_is_safe(self):
        self.assertEqual(findings('synthetic-fixture-only-not-a-real-secret'),[])

    def test_uuid_is_not_a_secret_pattern(self):
        self.assertEqual(findings('10000000-0000-4000-8000-000000000001'),[])
