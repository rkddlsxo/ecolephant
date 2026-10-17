# 프론트엔드

React 19 · TypeScript 5.9 · Vite 8 · npm workspace입니다. Node 22를 기준으로 구성했습니다.

## 실행

저장소 루트에서 `npm ci`, `npm run setup`, `npm run dev`를 순서대로 실행합니다.
프론트만 실행하려면 `npm run dev:frontend`를 사용합니다. API는 별도 실행되어야 합니다.

## 스택과 위치

| 역할 | 구현 |
|---|---|
| 라우팅 | TanStack Router · `src/router.tsx` |
| 서버 상태·HTTP·타입 | TanStack Query · Axios · OpenAPI 생성 타입, `src/api/` |
| 로컬 상태 | Zustand · `src/state/`, 설정만 브라우저 보관 |
| 폼·검증 | React Hook Form · Zod, `src/pages/PreparePage.tsx` |
| 스타일·컴포넌트 | Tailwind CSS 4 · Radix UI · CVA, `src/components/` |
| 드래그·전환 | dnd kit 카드 순서 변경 · Motion 화면 전환 |
| 품질 도구 | ESLint · Prettier · Husky · lint-staged |
| 테스트 도구 | Vitest · Testing Library 설정만 준비, 제품 테스트 미작성·미실행 |

개인 디자인 시스템의 GitHub Packages 이름·버전·권한이 없어 해당 패키지는 연결하지 않았습니다.
배포용 빌드는 `npm run build`입니다. 로컬 토큰은 개발 환경에서만 사용되어 배포 번들에 포함되지 않습니다.
Amplify 설정은 루트 `amplify.yml` 초안이며 로그인·도메인·SPA rewrite는 담당자 연결이 필요합니다.

[실행 안내](../docs/development/local.md) · [화면 설계](../docs/ui/screens.md) · [남은 부분](../docs/development/mvp-status.md).
