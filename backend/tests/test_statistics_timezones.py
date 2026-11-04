"""Time buckets follow the requested IANA zone, including offset transitions."""

from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant.metrics import time_buckets  # noqa: E402


def instant(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


class StatisticsTimezoneTests(unittest.TestCase):
    def test_hour_bucket_splits_at_a_non_hour_dst_transition(self):
        low = instant('2026-09-26T13:15:00Z')
        high = instant('2026-09-26T14:30:00Z')
        actual = [(start, end) for start, end, _ in time_buckets(low, high, ZoneInfo('Pacific/Chatham'), 'hour')]
        self.assertEqual(actual, [
            (low, instant('2026-09-26T14:00:00Z')),
            (instant('2026-09-26T14:00:00Z'), instant('2026-09-26T14:15:00Z')),
            (instant('2026-09-26T14:15:00Z'), high),
        ])

    def test_repeated_hour_occurrences_are_separate(self):
        low = instant('2026-11-01T05:00:00Z')
        high = instant('2026-11-01T07:00:00Z')
        zone = ZoneInfo('America/New_York')
        actual = [(start, end) for start, end, _ in time_buckets(low, high, zone, 'hour')]
        self.assertEqual(actual, [(low, instant('2026-11-01T06:00:00Z')),
                                  (instant('2026-11-01T06:00:00Z'), high)])
        self.assertEqual([start.astimezone(zone).hour for start, _ in actual], [1, 1])
        self.assertNotEqual(actual[0][0].astimezone(zone).utcoffset(), actual[1][0].astimezone(zone).utcoffset())

    def test_partial_interval_remains_contiguous(self):
        low = datetime(2026, 10, 17, 14, 59, 59, 500000, tzinfo=timezone.utc)
        high = instant('2026-10-17T15:00:01Z')
        actual = [(start, end) for start, end, _ in time_buckets(low, high, ZoneInfo('Asia/Seoul'), 'day')]
        self.assertEqual(actual, [(low, instant('2026-10-17T15:00:00Z')),
                                  (instant('2026-10-17T15:00:00Z'), high)])
