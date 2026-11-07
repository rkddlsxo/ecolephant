#!/usr/bin/env bash
set -euo pipefail

TARGET_REPLICAS=2
SCALE_UP_REPLICAS=$((TARGET_REPLICAS * 2))

//배포 시작 전에 현재 돌고 있는 구버전 컨테이너 2개의 ID를 변수에 저장해둡니다. (나중에 이 2개만 골라서 끄기 위함)
OLD_CONTAINERS=$(docker compose ps -q backend)
if [ -z "$OLD_CONTAINERS" ]; then
  docker compose up -d --build
  exit 0
fi

// --no-recreate : 기존 컨테이너를 재사용
// --scale backend="${SCALE_UP_REPLICAS}" : 백엔드 개수를 4개로 늘림
// --build : 이미지를 새로 빌드
docker compose build backend
docker compose up -d --no-deps --scale backend="${SCALE_UP_REPLICAS}" --no-recreate backend

//새로 뜬 컨테이너들이 준비도 안됐는데 구버전을 끄면 순단이 발생합니다.
//4개 컨테이너 모두 상태가 healthy가 될때 까지 최대 30초동안 1초 간격으로 확인하며 기다립니다.
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

// 죽은 구버전 컨테이너 ip를 nginx 목록에서 완전히 비우기 위해 한 번 더 reload하고, 최종적으로 127.0.0.1:8080/health가 정상 응답하는지 확인합니다.
docker compose exec -T web nginx -s reload
for old_id in $OLD_CONTAINERS; do
  docker stop "$old_id"
  docker rm -f "$old_id"
done

docker compose exec -T web nginx -s reload
curl -fsS http://127.0.0.1:8080/health
echo ""
