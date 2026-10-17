# 선택된 실행 스택

frontend는 React/TypeScript 5.9/Vite 8, ai는 순수 TypeScript, backend는 Flask/Python 3.12입니다.
npm workspace는 frontend와 ai를 묶고 API 타입은 OpenAPI에서 생성합니다.
로컬 저장은 SQLite, 운영 후보는 DynamoDB 어댑터입니다. 배포·실측 승인은 별도입니다.

`.tools`, `.data`, `.build`, `.venv`, node_modules, dist, cdk.out은 문서·소스 목록에서 제외합니다.
frontend는 ai를 가져올 수 있고, ai는 DOM·네트워크·저장소를 사용하지 않습니다.

[실행 안내](../../../docs/development/local.md) · [기술 결정](../../../docs/decisions/adr-0002-first-mvp-stack.md).
