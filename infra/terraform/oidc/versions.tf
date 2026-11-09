# terraform버전과 aws 공식 프로바이더버전을 고정합니다.
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.62.0"
    }
  }
}

# 생성되는 모든 리소스에 'Project = ecolephant' 와 'ManagedBy = terraform' 태그를 자동 추가합니다.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "ecolephant"
      ManagedBy = "terraform"
    }
  }
}
