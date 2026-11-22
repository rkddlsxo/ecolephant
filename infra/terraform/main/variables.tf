# 리전, 프로젝트명, ec2인스턴스 타입, SSH허용대역, 알람 수신 이메일 변수 정의

variable "aws_region" {
  type    = string
  default = "ap-northeast-2"
}

variable "project_name" {
  type    = string
  default = "ecolephant"
}

variable "instance_type" {
  type    = string
  default = "t3.medium"
}

variable "allowed_ssh_cidr" {
  type    = string
  default = "0.0.0.0/0"
}

variable "ssh_public_key" {
  type    = string
  default = ""
}

variable "alarm_email" {
  type    = string
  default = ""
}

# 인하대 캡스톤 공용 계정(inhasw)에서 사전 지급된 IAM Instance Profile(SafeInstanceProfile-inha-capstone-20)이 있을 경우
# 학생 계정에 iam:CreateRole 권한이 없어도 에러 없이 해당 프로필을 그대로 EC2에 연결합니다.
variable "existing_iam_instance_profile" {
  type    = string
  default = "SafeInstanceProfile-inha-capstone-20"
}

variable "team_account_name" {
  type    = string
  default = "inha-capstone-20"
}


