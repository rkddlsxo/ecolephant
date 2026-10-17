"""Loopback-only local entry point, without the Flask debugger."""
from waitress import serve
from ecolephant import create_app

if __name__ == "__main__":
    serve(create_app(), host="127.0.0.1", port=5000, threads=4, max_request_body_size=65536)
