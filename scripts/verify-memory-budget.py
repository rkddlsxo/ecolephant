"""AWS t4g.small (2048MB RAM) 스왑 쓰래싱 및 OOM 방지용 메모리 예산 계산기
컨테이너 전체 메모리 상한 총합(backend 2대 포함)이 OS 커널 여유분(최소 512MB)을 침범하지 않는지 검증
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
T4G_SMALL_TOTAL_MB = 2048
MIN_OS_HEADROOM_MB = 512


def calculate_container_memory_budget():
    text = (ROOT / "compose.aws-limits.yml").read_text(encoding="utf-8")
    limits_mb = [int(m) for m in re.findall(r"mem_limit:\s*(\d+)m", text)]
    # backend(256MB)는 무중단 배포를 위해 2대(replicas: 2)가 동시에 뜨므로 +256MB를 한 번 더 더해줍니다.
    total_allocated_mb = sum(limits_mb) + 256
    os_free_mb = T4G_SMALL_TOTAL_MB - total_allocated_mb
    if os_free_mb < MIN_OS_HEADROOM_MB:
        raise ValueError("OOM위험: OS 여유 메모리가 512MB 미만입니다.")

    return {
        "total_ram_mb": T4G_SMALL_TOTAL_MB,
        "allocated_containers_mb": total_allocated_mb,
        "os_headroom_mb": os_free_mb,
        "safe": True,
    }


if __name__ == "__main__":
    print(calculate_container_memory_budget())
