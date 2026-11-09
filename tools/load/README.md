# k6 동시 세션 부하 테스트 및 무중단 배포 검증

[클라우드 계획](../../docs/references/cloud-plan.md)의 목표 규모(사용자 10여 명)와 백엔드 스레드 구성(`threads=4` × 복제본 2개)을 기준으로, 기본 10개의 동시 가상 사용자(`TARGET_VUS=10`)가 세션 생성(`POST /api/v1/sessions`), 5초 배치 업로드(`POST /samples:batch`), 세션 완료(`POST /complete`), 타임라인 조회(`GET /timeline`)를 반복 실행할 때의 `p95` 지연시간과 에러율을 측정합니다.

가상 사용자 1명은 1초 주기로 6개 API를 연속 호출하므로 `TARGET_VUS=10`은 실제 브라우저(5초 주기 배치 전송) 기준 약 150명 이상의 동시 측정 트래픽에 해당합니다.

## 실행 방법

1. [로컬 실행 안내](../../docs/development/local.md)에 따라 Docker Compose(`127.0.0.1:8080`)를 기동합니다.
2. `backend/.env`의 `ECOLEPHANT_LOCAL_TOKEN` 값을 확인합니다.
3. 저장소 루트에서 k6 컨테이너로 [session.js](session.js)를 실행합니다 (목표 VU 수를 바꾸려면 `-e TARGET_VUS=20` 등을 지정합니다).

```sh
docker run --rm -i --network host \
  -e BASE_URL=http://127.0.0.1:8080 \
  -e AUTH_TOKEN="<ECOLEPHANT_LOCAL_TOKEN>" \
  -e TARGET_VUS=10 \
  grafana/k6 run - < tools/load/session.js
```

## 합격 기준 (Thresholds)

- `http_req_failed`: 에러율 `1%` 미만 (`rate<0.01`)
- `http_req_duration`: `p(95) < 500ms`

## 무중단 롤링 업데이트 검증 시나리오

1. 터미널 1에서 위 k6 부하 테스트를 실행해 지속적인 트래픽을 발생시킵니다.
2. 터미널 2에서 최대 부하 유지 구간(10~40초 사이)에 [rolling-update.sh](../../scripts/rolling-update.sh) 또는 [rolling-update.ps1](../../scripts/rolling-update.ps1)을 실행합니다.
3. 배포 완료 후 k6 결과 요약에서 `http_req_failed`가 `0.00%`로 유지되는지 확인합니다.
