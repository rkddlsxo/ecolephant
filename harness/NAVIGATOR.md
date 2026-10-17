# 작업별 짧은 문서 안내

공통 진입점은 [하네스 규칙](AGENTS.md), [제품 PRD](../PRD.md), [제품 아키텍처](../ARCHITECTURE.md)입니다.

| 작업 | 먼저 읽기 | 확인할 기준 |
|---|---|---|
| 범위·요구 추가 | [제품](docs/product/index.md) | [요구사항](../docs/product/requirements.md), [결정](../docs/decisions/open-decisions.md) |
| 화면·분석 설계 | [설계](docs/design/index.md) | [화면](../docs/ui/screens.md), [신호](../docs/measurement/signal-pipeline.md) |
| 의존·경계 변경 | [구조](docs/architecture/index.md) | [구조 정책](metadata/architecture-policy.json) |
| 역할별 확인 | [역할](docs/roles/index.md) | 계획·설계·구현·리뷰·보안·커밋·배포 |
| 기능·버그·문서 수정 | [작업 절차](docs/workflows/index.md) | [추적표](metadata/traceability.json) |
| API·도우미 구현 | [계약 검증](docs/quality/contracts.md) | [HTTP](../docs/api/README.md), [도우미](../docs/api/airpods-websocket.md) |
| 검증·품질 확인 | [품질](docs/quality/index.md) | [인수 시나리오](../docs/quality/acceptance.md), [실측](../docs/quality/measurement-validation.md) |
| 중단·재연결·저장 오류 | [안정성](docs/reliability/index.md) | [상태 전이](../docs/ui/state-machine.md) |
| 개인정보·인증·비밀정보 | [보안](docs/security/index.md) | [제품 보안](../docs/security/privacy-and-security.md) |
| 다음 작업·기술 부채 | [계획](docs/plans/index.md) | [템플릿](docs/templates/index.md) |
| 검사·문서 정비 | [검사 안내](scripts/README.md) | [검사 보고서](reports/harness-restructure.md) |
| 참고 구조·전체 위치 | [참고](docs/references/index.md) | [전체 문서 지도](generated/document-map.md) |

## 실행 코드

[로컬 실행](../docs/development/local.md) · [현재 구현 상태](../docs/development/mvp-status.md) · [스택 경계](docs/architecture/runtime.md).
