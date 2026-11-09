# aws_region("ap-northeast-2"), github_repository("rkddlsxo/ecolephant"), allowed_branch("main"),
# role_name("ecolephant-github-actions-deploy")을 하드코딩 대신 변수로 분리합니다.
variable "aws_region" {
  type    = string
  default = "ap-northeast-2"
}

variable "github_repository" {
  type    = string
  default = "rkddlsxo/ecolephant"
}

variable "allowed_branch" {
  type    = string
  default = "main"
}

variable "role_name" {
  type    = string
  default = "ecolephant-github-actions-deploy"
}
