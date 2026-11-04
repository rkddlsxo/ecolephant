"""Ensure the HTTP timestamp contract and parser agree on boundary inputs."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant.contracts import timestamp, validate  # noqa: E402
from ecolephant.errors import ApiError  # noqa: E402


class TimestampPrecisionTests(unittest.TestCase):
    def test_contract_and_parser_accept_exact_milliseconds(self):
        values = ['2026-10-17T10:00:00Z', '2026-10-17t10:00:00.123000z',
                  '2026-10-17T19:00:00.123000000+09:00']
        for value in values:
            with self.subTest(value=value):
                validate('MillisecondTimestamp', value)
                self.assertEqual(timestamp(value).microsecond % 1000, 0)

    def test_contract_and_parser_reject_invalid_or_submillisecond_input(self):
        values = ['2026-10-17T10:00:00.12300001Z', '2026-10-17T10:00:00.0001Z',
                  '2026-10-17 10:00:00+00:00', '2026-10-17T10:00:00',
                  '2026-02-30T10:00:00Z', '2026-10-17T10:00:60Z']
        for value in values:
            with self.subTest(value=value):
                with self.assertRaises(ApiError):
                    validate('MillisecondTimestamp', value)
                with self.assertRaises(ApiError):
                    timestamp(value)


if __name__ == '__main__':
    unittest.main()
