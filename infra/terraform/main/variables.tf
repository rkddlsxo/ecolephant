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
  default = "t4g.small"
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

