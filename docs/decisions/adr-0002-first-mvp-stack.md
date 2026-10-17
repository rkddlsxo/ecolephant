# ADR-0002 · 사용자 지정 스택과 1차 데모

- 날짜: 2026-10-17
- 상태: 사용자 지정 스택 반영, 로컬 개발 선택, 운영 배포 미정.
- 관련: DEC-001, DEC-005, DEC-006, DEC-008, DEC-010.

## 확정 입력

사용자가 Flask 백엔드와 React·TypeScript 5.9·Vite 8·Node 22 프론트를 지정했습니다.
라우터·서버 상태는 TanStack, 로컬 상태는 Zustand, 폼은 RHF/Zod, 스타일은 Tailwind 4·Radix·CVA입니다.
dnd kit·Motion·Axios·OpenAPI 타입 생성·Vitest/Testing Library·ESLint/Prettier/Husky/lint-staged를 구성했습니다.
개인 디자인 시스템 패키지 식별자는 전달받지 못해 로컬 컴포넌트만 사용합니다.

## 1차 MVP 구현 선택

- ai는 기존 ADR의 브라우저 경계를 유지하는 TypeScript 순수 함수 패키지입니다. 실제 모델 선택은 미정입니다.
- 실제 센서·각도 매핑을 꾸미지 않고 data_source=demo인 합성 입력만 저장합니다.
- 첫 실행은 AWS·Docker 없이 가능한 Flask + SQLite입니다. 이는 운영 DB 확정이 아닙니다.
- 로컬 전용 무작위 토큰으로 기록 소유자를 분리합니다. Cognito 로그인 출시 결정을 대신하지 않습니다.
- DynamoDB Local/AWS 어댑터, CDK, Amplify 설정은 후속 통합용 초안으로 추가합니다.
- 첨부 계획의 4개 테이블 대신 초기 단일 테이블을 사용하며 논리 엔티티는 pk/sk로 구분합니다. 운영 적용은 리뷰 대기입니다.
- 호스팅은 이미지의 Amplify와 문서의 S3+CloudFront가 달라 담당자와 최종 확정해야 합니다.

## 검증 경계

정적 빌드·린트·문서 검사는 센서 정확도, 알림 인지, 실환경 보안·배포 검증과 다릅니다.
기존 인수 시나리오는 실행 증거가 없어 planned를 유지합니다. [현황](../development/mvp-status.md)을 참조합니다.

## 공식 구현 참고

- [Flask 앱 생성](https://flask.palletsprojects.com/en/stable/patterns/appfactories/)
- [TanStack 코드 라우팅](https://tanstack.com/router/latest/docs/routing/code-based-routing)
- [Tailwind Vite 연결](https://tailwindcss.com/docs/installation/using-vite)
- [Amplify 모노레포](https://docs.aws.amazon.com/amplify/latest/userguide/monorepo-configuration.html)
