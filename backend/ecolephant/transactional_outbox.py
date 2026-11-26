"""Transactional Outbox 패턴 & SQS/SNS 리포트 알림 릴레이.

Dual Write Problem (이중 쓰기 불일치)
사용자가 자세 측정을 끝냈을 때 백엔드가:
  1) DB(RDS PostgreSQL)에 "세션 완료!" 저장 (UPDATE sessions ...)
  2) 메시지 큐(SQS)에 "AI 주간 리포트 만들어서 SNS 이메일 보내줘!" 발행 (sqs.send_message)
  1번과 2번 사이에 네트워크가 끊겨 2번이 실패하면 세션은 완료됬는데 AI리포트 이메일은 영원히 발송되지 않는 데이터 불일치 사고 발생

해결책: Transactional Outbox 패턴
1) DB에 세션을 저장할 때, 외부 SQS를 직접 부르지 않고 같은 DB 트랜잭션 안의 임시 발송함 표(`outbox_events`)에 이벤트를 함께 저장(PENDING).
   (같은 DB 트랜잭션이므로 둘 다 성공하거나 둘 다 취소되어 100% 원자성이 보장됨!)
2) 별도의 릴레이 일꾼(`relay_pending_events`)이 `outbox_events` 표에서 아직 안 보낸(`PENDING`) 편지를 꺼내 SQS/SNS로 안전하게 전송하고 완료 도장(`PUBLISHED`).
"""
import json


class TransactionalOutboxStore:
    """DB 내부의 임시 발송함(outbox_events 테이블)과 SQS/SNS 릴레이 워커를 관리."""

    def __init__(self):
        self.sessions = {}
        self.outbox_events = []
        self._next_event_id = 1

    # 세션 완료 저장과 아웃박스 이벤트 기록을 하나의 원자적 작업(같은 DB 트랜잭션)으로 묶어 처리
    def complete_session_with_outbox(self, owner, session_id, summary_payload, simulate_db_error=False):
        staged_session = {"id": session_id, "owner": owner, "status": "completed", "summary": summary_payload}
        staged_event = {
            "event_id": f"outbox-{self._next_event_id}",
            "owner": owner,
            "session_id": session_id,
            "event_type": "SESSION_COMPLETED_REPORT",
            "payload": json.dumps(summary_payload, separators=(",", ":"), sort_keys=True),
            "status": "PENDING",
        }
        if simulate_db_error:
            raise RuntimeError("DB transaction rolled back: session and outbox event both aborted")

        self._next_event_id += 1
        self.sessions[session_id] = staged_session
        self.outbox_events.append(staged_event)
        return staged_event["event_id"]

    # 아웃박스 발송함에서 아직 안 보낸('PENDING') 이벤트를 찾아 SQS/SNS로 보내고 'PUBLISHED'로 상태를 바꿈.
    def relay_pending_events(self, sqs_publish_fn, sns_notify_fn=None):
        relayed_count = 0
        for event in self.outbox_events:
            if event["status"] != "PENDING":
                continue
            # SQS 큐로 리포트 생성 메시지를 전송하고, SNS 알림 함수가 있으면 이메일 알림도 함께 발송.
            sqs_publish_fn(event)
            if sns_notify_fn is not None:
                sns_notify_fn(event)
            event["status"] = "PUBLISHED"
            relayed_count +=1

        return relayed_count
