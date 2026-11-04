"""Dynamo retries must preserve transient failure and concurrent-write semantics."""

from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant.dynamo import DynamoRepository  # noqa: E402
from ecolephant.errors import ApiError  # noqa: E402


class DynamoRetryErrors(unittest.TestCase):
    def setUp(self):
        self.repository = object.__new__(DynamoRepository)
        self.repository.get = Mock(side_effect=[{'session_id': 'session-a'}, None])

    def verify_failure(self, original, expected_status, expected_code):
        self.repository.load_metadata = Mock(side_effect=original)
        with self.assertRaises(ApiError) as caught:
            self.repository.find_create('owner', 'key', {'client_session_id': 'client'})
        self.assertEqual((caught.exception.status, caught.exception.code), (expected_status, expected_code))

    def test_transient_storage_error_is_not_reported_as_a_deleted_session(self):
        self.verify_failure(ApiError(503, 'storage_unavailable', 'temporary'), 503, 'storage_unavailable')

    def test_concurrent_write_is_retryable(self):
        self.verify_failure(ApiError(409, 'concurrent_write', 'retry'), 409, 'concurrent_write')

    def test_deleted_session_still_reports_its_conflict(self):
        self.verify_failure(ApiError(404, 'not_found', 'deleted'), 409, 'deleted_session')
