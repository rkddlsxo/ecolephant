from functools import wraps
import hashlib
import hmac

import jwt
from flask import current_app, g, request
from .errors import ApiError


def require_owner(handler):
    @wraps(handler)
    def authenticated(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer ") or len(header) > 8192:
            raise ApiError(401, "unauthorized", "인증 정보를 확인해 주세요.")
        token = header[7:]
        if current_app.config["AUTH_MODE"] == "local":
            expected = current_app.config["LOCAL_TOKEN"]
            if not expected or not hmac.compare_digest(token, expected):
                raise ApiError(401, "unauthorized", "로컬 실행 설정을 확인해 주세요.")
            g.owner = "local-" + hashlib.sha256(token.encode()).hexdigest()[:24]
        else:
            try:
                key = current_app.extensions["jwks"].get_signing_key_from_jwt(token)
                claims = jwt.decode(token, key.key, algorithms=["RS256"],
                                    issuer=current_app.config["JWT_ISSUER"],
                                    options={"verify_aud": False, "require": ["exp", "iat", "sub"]})
                audience = claims.get("client_id") if claims.get("token_use") == "access" else claims.get("aud")
                if claims.get("token_use") not in {"access", "id"} or audience != current_app.config["JWT_CLIENT_ID"]:
                    raise ValueError()
                g.owner = claims["sub"]
            except (jwt.PyJWTError, ValueError, KeyError):
                raise ApiError(401, "unauthorized", "로그인이 만료되었거나 유효하지 않습니다.") from None
        return handler(*args, **kwargs)
    return authenticated
