"""S3 Presigned URL(5분 만료 가드레일) 및 ObjectCreated 무인 Lambda 트리거 단위 테스트."""
import unittest

from backend.ecolephant.s3_presigned_event import (
    create_s3_presigned_download_url,
    handle_s3_object_created_trigger,
)


class S3PresignedAndEventTriggerTest(unittest.TestCase):
    def test_presigned_url_allows_up_to_300s_and_blocks_excessive_expiry(self):
        url = create_s3_presigned_download_url(
            "inha-capstone-20-ecolephant",
            "reports/weekly_user1.json",
            expires_in_seconds=300,
            now_fn=lambda: 1000,
        )
        self.assertIn("https://inha-capstone-20-ecolephant.s3.ap-northeast-2.amazonaws.com/", url)
        self.assertIn("X-Amz-Expires=300", url)
        self.assertIn("X-Amz-ExpiresAt=1300", url)

        # 거부 케이스 1: 300초(5분) 초과 만료 시간 차단
        with self.assertRaises(ValueError):
            create_s3_presigned_download_url("inha-capstone-20-ecolephant", "reports/a.json", expires_in_seconds=3600)

        # 거부 케이스 2: 미승인 버킷명 차단
        with self.assertRaises(ValueError):
            create_s3_presigned_download_url("unapproved-bucket", "reports/a.json", expires_in_seconds=60)

    def test_s3_object_created_event_triggers_ai_report_automatically(self):
        called = []
        s3_event = {
            "Records": [
                {
                    "eventName": "ObjectCreated:Put",
                    "s3": {
                        "bucket": {"name": "inha-capstone-20-ecolephant"},
                        "object": {"key": "telemetry/year%3D2026/session_101.json"},
                    },
                }
            ]
        }
        res = handle_s3_object_created_trigger(s3_event, lambda b, k: called.append((b, k)))
        self.assertEqual(res["triggered_count"], 1)
        self.assertEqual(called[0][1], "telemetry/year=2026/session_101.json")


if __name__ == "__main__":
    unittest.main()
