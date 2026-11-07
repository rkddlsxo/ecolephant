from flask import g, jsonify


class ApiError(Exception):
    def __init__(self, status, code, message, issues=None):
        self.status, self.code, self.message, self.issues = status, code, message, issues


#g는 flask에서 현재 들어온 http요청 1개가 시작해서 끝날 때까지만 유지되는 임시 메모장 객체
def problem(error):
    g.error_code = error.code
    body = {"code": error.code, "message": error.message, "request_id": g.request_id}
    if error.issues:
        body["issues"] = error.issues
    response = jsonify(body)
    response.status_code = error.status
    response.content_type = "application/problem+json"
    return response
