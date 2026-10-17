from flask import g, jsonify


class ApiError(Exception):
    def __init__(self, status, code, message, issues=None):
        self.status, self.code, self.message, self.issues = status, code, message, issues


def problem(error):
    body = {"code": error.code, "message": error.message, "request_id": g.request_id}
    if error.issues:
        body["issues"] = error.issues
    response = jsonify(body)
    response.status_code = error.status
    response.content_type = "application/problem+json"
    return response
