#!/usr/bin/env bash
set -euo pipefail

TARGET_REPLICAS=2
SCALE_UP_REPLICAS=$((TARGET_REPLICAS * 2))

# 나중에 구버전만 골라서 종료하기 위해, 지금 돌고 있는 구버전 백엔드 2개의 ID를 미리 적어둠.
OLD_CONTAINERS=$(docker compose ps -q backend)
if [ -z "$OLD_CONTAINERS" ]; then
  npm run build
  docker compose up -d --build
  exit 0
fi

# 기존 구버전 2개는 건드리지 않고 --no-recreate,
# 백엔드 인원을 4개으로 늘려서 --scale backend=4, 새 코드를 배운 신버전 2개을 추가로 투입.
docker compose build backend
docker compose up -d --no-deps --scale backend="${SCALE_UP_REPLICAS}" --no-recreate backend

#새로 뜬 신버전 컨테이너들이 완전히 켜져서 healthy가 끝날 때 까지 최대 30초 동안 기다림.
ALL_CONTAINERS=$(docker compose ps -q backend)
for cid in $ALL_CONTAINERS; do
  for attempt in $(seq 1 30); do
    status=$(docker inspect --format='{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "starting")
    if [ "$status" = "healthy" ]; then
      break
    fi
    if [ "$attempt" -eq 30 ]; then
      echo "Healthcheck failed for container: $cid"
      exit 1
    fi
    sleep 1
  done
done

# 신버전 2개가 준비됬으니, 맨 처음 적어둔 구 버전 컨테이너 2개만 골라서 종료
docker compose exec -T web nginx -s reload
for old_id in $OLD_CONTAINERS; do
  docker stop "$old_id"
  docker rm -f "$old_id"
done

# 백엔드가 새 정책(draft-web-v2)를 먼저 지원하도록 교체가 끝났으니 이제 프론트 화면을 새로 빌드해 반영
npm run build
docker compose exec -T web nginx -s reload
curl -fsS http://127.0.0.1:8080/health
echo ""
