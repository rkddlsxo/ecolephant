# 인증과 개인정보

헬스체크 외 API는 인증 문맥의 소유자를 사용하며 요청 본문의 소유자 ID를 신뢰하지 않습니다.
다른 사용자의 조회·삭제, 토큰 만료, 원본 영상·관절점·원시 IMU 거부를 검사합니다.
로컬 토큰과 시험용 JWT 검사 결과는 실제 Cognito 계정·운영 인증 검증과 구분합니다.

[보안 명세](../../../../docs/security/privacy-and-security.md) · [인증 안내](../../../../docs/development/authentication.md)
