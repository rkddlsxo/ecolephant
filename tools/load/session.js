//k6내장 HTTP 클라이언트, 응답 검증(check), 대기(sleep)함수와 세션.멱등성. 키 생성용 UUID함수를 불러온다.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

//코드에 인증토큰을 하드코딩하지 않고 실행 시 환경변수로 주입받습니다.
//기본 대상 주소는 nginx프록시 입니다.
const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8080';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

export const options = {
  scenarios: {
    concurrent_sessions: {
      //가상 사용자(VU)수를 단계적으로 늘리고 줄이는 실행기
      executor: 'ramping-vus',
      startVUs: 0,

      //처음 10초동안 접속자(VU)를 0명에서 50명까지 서서히 늘립니다.(ramp-up)
      //30초동안 50명 유지
      //10초동안 접속자(VU)를 50명에서 0명까지 서서히 줄입니다.(ramp-down)
      stages: [
        { duration: '10s', target: 50 },
        { duration: '30s', target: 50 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

//헤더를 만들고, 세션 생성 요청처럼 멱등성 키가 필요할 때는 idempotency_key 헤더를 덧붙입니다.
function buildHeaders(idempotencyKey) {
  const headers = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return headers;
}

function makeSample(seq, angleDeg) {
  const high = angleDeg >= 30;
  return {
    seq: seq,
    elapsed_start_ms: (seq - 1) * 1000,
    duration_ms: 1000,
    calibration_epoch: 1,
    active_mode: 'webcam',
    quality: 'valid',
    camera_estimate_deg: angleDeg,
    head_flexion_deg: null,
    //가상 사용자 1명의 전체 행동 흐름
    display_angle_deg: angleDeg,
    posture_level: high ? 'high' : 'normal',
    reason_code: high ? 'forward_shift' : 'within_range',
    confidence: 'single_sensor',
  };
}

export default function () {
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health is 200': (r) => r.status === 200,
  });

  if (!AUTH_TOKEN) {
    sleep(1);
    return;
  }

  const policiesRes = http.get(`${BASE_URL}/api/v1/policies`, {
    headers: buildHeaders(),
  });
  const policiesOk = check(policiesRes, {
    'policies is 200': (r) => r.status === 200,
  });
  if (!policiesOk) {
    sleep(1);
    return;
  }

  const policyId = policiesRes.json('items.0.policy_id');
  const startedAt = new Date(Date.now() - 10000).toISOString();

  const createRes = http.post(
    `${BASE_URL}/api/v1/sessions`,
    JSON.stringify({
      client_session_id: uuidv4(),
      started_at: startedAt,
      requested_mode: 'webcam',
      policy_id: policyId,
      initial_calibration_epoch: 1,
      data_source: 'demo',
    }),
    { headers: buildHeaders(uuidv4()) },
  );


  const createdOk = check(createRes, {
    'session created 201': (r) => r.status === 201,
  });
  if (!createdOk) {
    sleep(1);
    return;
  }

  const sessionId = createRes.json('id');
  const batchSamples = [
    makeSample(1, 12),
    makeSample(2, 15),
    makeSample(3, 32),
    makeSample(4, 34),
    makeSample(5, 14),
  ];

  //fianl_seq: 5로 세션을 정상 종료해 서버 집계를 실행시키고, 이어서 1분 버킷 타임라인 조회까지 정상 응답하는지 확인합니다.
  const batchRes = http.post(
    `${BASE_URL}/api/v1/sessions/${sessionId}/samples:batch`,
    JSON.stringify({ samples: batchSamples }),
    { headers: buildHeaders() },
  );
  check(batchRes, {
    'batch ingested 200': (r) => r.status === 200,
    'acknowledged_through_seq is 5': (r) => r.json('acknowledged_through_seq') === 5,
  });

  const endedAt = new Date(Date.parse(startedAt) + 5000).toISOString();
  const completeRes = http.post(
    `${BASE_URL}/api/v1/sessions/${sessionId}/complete`,
    JSON.stringify({
      ended_at: endedAt,
      final_seq: 5,
      final_event_seq: 0,
    }),
    { headers: buildHeaders() },
  );
  check(completeRes, {
    'session completed 200': (r) => r.status === 200,
  });

  const timelineRes = http.get(
    `${BASE_URL}/api/v1/sessions/${sessionId}/timeline`,
    { headers: buildHeaders() },
  );
  check(timelineRes, {
    'timeline 200': (r) => r.status === 200,
  });

  sleep(1);
}
