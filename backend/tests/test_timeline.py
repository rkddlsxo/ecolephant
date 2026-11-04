"""Synthetic boundary and scaling tests for the elapsed-time timeline."""
import unittest
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecolephant.metrics import extend_timeline_cache, indexed_timeline, timeline, valid_timeline_cache  # noqa: E402


class CountingSamples(dict):
    scans = 0

    def values(self):
        self.scans += 1
        return super().values()


class TimelineTests(unittest.TestCase):
    def test_incremental_cache_matches_raw_for_varied_windows(self):
        generator = random.Random(28)
        state = {'tail_end_ms': 0, 'timeline_cache': {'version': 1, 'completed_until_ms': 0, 'partial': None}}
        samples, completed, cursor = {}, [], 0
        for seq in range(1, 2001):
            mode = generator.choice(['webcam', 'airpods', 'combined', 'none'])
            quality = generator.choice(['valid', 'motion', 'paused']) if mode != 'none' else 'no_sensor'
            item = {'elapsed_start_ms': cursor, 'duration_ms': generator.randint(1, 1000),
                    'quality': quality, 'posture_level': generator.choice(['normal', 'caution', 'high']),
                    'active_mode': mode}
            cache, newly_completed = extend_timeline_cache(state, [item])
            self.assertIsNotNone(cache)
            cursor += item['duration_ms']
            samples[seq] = item
            completed.extend(newly_completed)
            state.update(tail_end_ms=cursor, timeline_cache=cache)
            if seq % 73 == 0 or seq == 2000:
                self.assertTrue(valid_timeline_cache(cache, cursor))
                self.assertEqual(indexed_timeline(completed, cache, 0, cursor),
                                 timeline({'samples': samples}, 0, cursor))

    def test_cross_boundary_sample_and_single_scan(self):
        samples = CountingSamples({1: {
            'elapsed_start_ms': 59500, 'duration_ms': 1000, 'quality': 'valid',
            'posture_level': 'normal', 'active_mode': 'webcam',
        }})
        buckets = timeline({'samples': samples}, 0, 180000)
        self.assertEqual(samples.scans, 1)
        self.assertEqual([b['normal_ms'] for b in buckets], [500, 500, 0])
        self.assertEqual([b['unknown_ms'] for b in buckets], [59500, 59500, 60000])
        self.assertEqual([b['active_modes'] for b in buckets], [['webcam'], ['webcam'], []])
        partial = timeline({'samples': samples}, 30000, 90000)
        self.assertEqual(partial[0]['normal_ms'], 1000)
        self.assertEqual(partial[0]['unknown_ms'], 59000)


if __name__ == '__main__':
    unittest.main()
