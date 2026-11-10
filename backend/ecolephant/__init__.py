from pathlib import Path
import hashlib
import json
import logging
import os
import sqlite3
import time
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
        POSTGRES_DSN=os.getenv(
            "ECOLEPHANT_POSTGRES_DSN",
            "postgresql://ecolephant:ecolephant_local@localhost:5432/ecolephant",
        ),
        TABLE=os.getenv("ECOLEPHANT_TABLE", "ecolephant-local"),
        ENDPOINT=os.getenv("AWS_ENDPOINT_URL_DYNAMODB"),
        JWT_ISSUER=os.getenv("ECOLEPHANT_JWT_ISSUER", ""),
        JWT_CLIENT_ID=os.getenv("ECOLEPHANT_JWT_CLIENT_ID", ""),
        ALLOWED_ORIGIN=os.getenv("ECOLEPHANT_ALLOWED_ORIGIN", "http://127.0.0.1:5173"),
        MAX_CONTENT_LENGTH=65536,
    )
    if config:
        app.config.update(config)
    # 파이썬 logging의 기본 출력 기준은 warning입니다. 그래서 이 줄이 없으면 app.logger.info를 아무리 호출해도 콘솔에 아무것도 안 찍힙니다.abs
    #단, Testing=true(단위테스트 실행 중)일 때는 기존 190개 테스트가 돌아갈 때 화면에 로그 수천 줄이 쏱아지지 않도록 평소엔 꺼두고, 운영/도커 실행시에만 INFO를 켭니다.
    if not app.config.get("TESTING"):
        app.logger.setLevel(logging.INFO)
    from .policies import load_catalog
    app.extensions["policies"] = load_catalog(app.config.get("POLICIES"))
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
    elif app.config["STORAGE"] in {"postgres", "postgresql"}:
        from .postgres import PostgresRepository
        app.extensions["repository"] = PostgresRepository(app.config["POSTGRES_DSN"])
    else:
        raise RuntimeError("Unsupported storage mode")

    # 라우트 함수가 실행되기 직전에 무조건 먼저 실행된다.
    @app.before_request
    def initialize_request():
        g.request_id = str(uuid4())
        g.started_ns = time.monotonic_ns()
        if request.method in {"POST", "PUT", "PATCH"}:
            #서버가 NTP시간 동기화를 하느라 시계가 0.1초 뒤로 감기면 time.time()은 응답시간이 음수가 될 수 있습니다.
            if not request.is_json:
                raise ApiError(400, "json_required", "JSON 요청이 필요합니다.")
            try:
                json.loads(request.get_data(), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            except (ValueError, UnicodeError):
                raise ApiError(400, "invalid_json", "올바른 JSON 요청이 필요합니다.") from None

    # 요청 처리가 다 끝나고 클라이언트에게 응답을 돌려주기 직전에 실행
    @app.after_request
    def response_headers(response):
        request_id = getattr(g, "request_id", str(uuid4()))
        response.headers["X-Request-ID"] = request_id
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        origin = request.headers.get("Origin")
        if origin and origin == app.config["ALLOWED_ORIGIN"]:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Idempotency-Key"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        started_ns = getattr(g, "started_ns", None)
        latency_ms = round((time.monotonic_ns() - started_ns) / 1_000_000, 2) if started_ns is not None else 0.0
        owner = getattr(g, "owner", None)
        owner_hash = hashlib.sha256(owner.encode()).hexdigest()[:12] if owner else None
        entry = {
            "request_id": request_id,
            "method": request.method,
            "path": request.path,
            "status": response.status_code,
            "latency_ms": latency_ms,
            "owner_hash": owner_hash,
            "error_code": getattr(g, "error_code", None),
        }
        app.logger.info(json.dumps(entry, separators=(",", ":")))
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
