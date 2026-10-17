from pathlib import Path
import json
import os
import sqlite3
from uuid import uuid4

from dotenv import load_dotenv
from flask import Flask, g, request
from werkzeug.exceptions import BadRequest, HTTPException, RequestEntityTooLarge

from .errors import ApiError, problem


def create_app(config=None):
    base = Path(__file__).resolve().parents[1]
    load_dotenv(base / ".env")
    app = Flask(__name__)
    app.config.from_mapping(
        AUTH_MODE=os.getenv("ECOLEPHANT_AUTH_MODE", "local"),
        LOCAL_TOKEN=os.getenv("ECOLEPHANT_LOCAL_TOKEN", ""),
        STORAGE=os.getenv("ECOLEPHANT_STORAGE", "sqlite"),
        DATABASE=os.getenv("ECOLEPHANT_DATABASE", str(base.parent / ".data/ecolephant.sqlite3")),
        TABLE=os.getenv("ECOLEPHANT_TABLE", "ecolephant-local"),
        ENDPOINT=os.getenv("AWS_ENDPOINT_URL_DYNAMODB"),
        JWT_ISSUER=os.getenv("ECOLEPHANT_JWT_ISSUER", ""),
        JWT_CLIENT_ID=os.getenv("ECOLEPHANT_JWT_CLIENT_ID", ""),
        ALLOWED_ORIGIN=os.getenv("ECOLEPHANT_ALLOWED_ORIGIN", "http://localhost:5173"),
        MAX_CONTENT_LENGTH=65536,
    )
    if config:
        app.config.update(config)
    if app.config["AUTH_MODE"] not in {"local", "cognito"}:
        raise RuntimeError("Unsupported authentication mode")
    if app.config["AUTH_MODE"] == "local":
        if os.getenv("AWS_LAMBDA_FUNCTION_NAME") or not app.config["LOCAL_TOKEN"]:
            raise RuntimeError("Run npm run setup locally; Lambda requires Cognito authentication")
        app.config["TRUSTED_HOSTS"] = ["localhost", "127.0.0.1", "[::1]"]
    else:
        if not app.config["JWT_ISSUER"].startswith("https://cognito-idp.") or not app.config["JWT_CLIENT_ID"]:
            raise RuntimeError("Cognito issuer and client ID are required")
        import jwt
        app.extensions["jwks"] = jwt.PyJWKClient(app.config["JWT_ISSUER"] + "/.well-known/jwks.json")
    if app.config["STORAGE"] == "sqlite":
        from .storage import SQLiteRepository
        database = Path(app.config["DATABASE"])
        if not database.is_absolute():
            database = base.parent / database
        app.extensions["repository"] = SQLiteRepository(database)
    elif app.config["STORAGE"] == "dynamodb":
        from .dynamo import DynamoRepository
        app.extensions["repository"] = DynamoRepository(app.config["TABLE"], app.config["ENDPOINT"])
    else:
        raise RuntimeError("Unsupported storage mode")

    @app.before_request
    def initialize_request():
        g.request_id = str(uuid4())
        if request.method in {"POST", "PUT", "PATCH"}:
            if not request.is_json:
                raise ApiError(400, "json_required", "JSON 요청이 필요합니다.")
            try:
                json.loads(request.get_data(), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            except (ValueError, UnicodeError):
                raise ApiError(400, "invalid_json", "올바른 JSON 요청이 필요합니다.") from None

    @app.after_request
    def response_headers(response):
        response.headers["X-Request-ID"] = getattr(g, "request_id", str(uuid4()))
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        origin = request.headers.get("Origin")
        if origin and origin == app.config["ALLOWED_ORIGIN"]:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Idempotency-Key"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        return response

    @app.errorhandler(ApiError)
    def api_error(error):
        return problem(error)

    @app.errorhandler(Exception)
    def unexpected(error):
        if not hasattr(g, "request_id"):
            g.request_id = str(uuid4())
        if isinstance(error, RequestEntityTooLarge):
            return problem(ApiError(413, "request_too_large", "요청은 64KiB 이하여야 합니다."))
        if isinstance(error, BadRequest):
            return problem(ApiError(400, "invalid_request", "요청 구문을 확인해 주세요."))
        if isinstance(error, HTTPException):
            return problem(ApiError(error.code, "http_error", "요청 경로와 방법을 확인해 주세요."))
        if isinstance(error, sqlite3.Error):
            return problem(ApiError(503, "storage_unavailable", "저장소를 다시 연결해 주세요."))
        # Exception values and request bodies can contain sensitive input; do not log them.
        app.logger.error("request_failed request_id=%s error_type=%s", g.request_id, type(error).__name__)
        return problem(ApiError(503, "service_unavailable", "처리를 완료하지 못했습니다. 다시 시도해 주세요."))

    from .routes import api
    app.register_blueprint(api)
    return app
