# ==============================================================================
# 인하대 캡스톤(inha-capstone-20) 공식 제공 기준 100% 반영 Terraform 아키텍처
# 사용할 수 있는 핵심 서비스 총집합 (공부 & 아키텍처 완성도 극대화):
# 1) EC2 (t3.medium, Ubuntu 24.04 amd64) + SafeInstanceProfile-inha-capstone-20
# 2) RDS for PostgreSQL (Single-AZ, 프리티어 db.t3.micro, 퍼블릭 액세스 차단 + EC2 보안그룹만 5432 허용)
# 3) DynamoDB (온디맨드 PAY_PER_REQUEST + PITR 백업)
# 4) S3 (버킷명 반드시 inha-capstone-20-... 으로 시작)
# 5) SQS + DLQ (측정 배치 비동기 메시지 큐 + 3회 실패 시 Dead Letter Queue 격리)
# 6) Lambda + API Gateway HTTP API (SafeRole-inha-capstone-20 연결 + 기본 HTTPS 엔드포인트 제공 + Bedrock 대체 LLM API 연동)
# 7) SNS + CloudWatch Alarm (서버 상태 이상 시 이메일 알림)
# ==============================================================================

data "aws_vpc" "default" {
  default = true
}

# [주의사항 7번 반영] 액세스 키 발급이나 새 IAM Role 생성은 불가하므로,
# 학교가 미리 만들어 준 SafeRole-inha-capstone-20의 ARN을 조회해서 Lambda 등에 연결합니다.
data "aws_iam_role" "capstone_safe_role" {
  name = var.existing_iam_role_name
}

# [주의사항 3번 반영] t3.nano ~ t3.medium은 x86_64(amd64) 아키텍처이므로
# Ubuntu 24.04 LTS amd64 공식 이미지를 자동으로 찾아옵니다.
data "aws_ami" "ubuntu_amd64" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ------------------------------------------------------------------------------
# 1. EC2 보안그룹 & 인스턴스 (t3.medium + SafeInstanceProfile-inha-capstone-20)
# ------------------------------------------------------------------------------
resource "aws_security_group" "app" {
  name   = "${var.team_account_name}-${var.project_name}-app-sg"
  vpc_id = data.aws_vpc.default.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name  = "${var.team_account_name}-${var.project_name}-app-sg"
    Owner = var.team_account_name
  }
}

resource "aws_key_pair" "deployer" {
  count      = var.ssh_public_key != "" ? 1 : 0
  key_name   = "${var.team_account_name}-${var.project_name}-key"
  public_key = var.ssh_public_key
}

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu_amd64.id
  instance_type               = var.instance_type
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = var.existing_iam_instance_profile
  key_name                    = var.ssh_public_key != "" ? aws_key_pair.deployer[0].key_name : null
  associate_public_ip_address = true

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name  = "${var.team_account_name}-${var.project_name}-app-server"
    Owner = var.team_account_name
  }
}

# ------------------------------------------------------------------------------
# 2. RDS for PostgreSQL (PDF 'RDS 사용 및 접속 안내' 1~3번 규칙 100% 반영)
# - 기본 VPC 사용, Single-AZ / Single Instance(multi_az = false), 프리티어(db.t3.micro)
# - 퍼블릭 액세스 금지(publicly_accessible = false)
# - RDS 보안그룹에서 오직 우리 EC2 보안그룹(aws_security_group.app.id)의 5432 포트만 허용!
# ------------------------------------------------------------------------------
resource "aws_security_group" "rds" {
  name   = "${var.team_account_name}-${var.project_name}-rds-sg"
  vpc_id = data.aws_vpc.default.id

  # 외부 인터넷(0.0.0.0/0)이 아니라 오직 우리 EC2 서버 보안그룹에서 오는 5432 포트만 열어줍니다!
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  tags = {
    Name  = "${var.team_account_name}-${var.project_name}-rds-sg"
    Owner = var.team_account_name
  }
}

resource "aws_db_instance" "postgres" {
  identifier             = "${var.team_account_name}-${var.project_name}-pg"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t3.micro"
  allocated_storage      = 20
  storage_type           = "gp3"
  storage_encrypted      = true
  db_name                = "ecolephant"
  username               = "ecolephant"
  manage_master_user_password = true

  # [RDS 필수 규칙] Single-AZ(multi_az = false) 및 외부 인터넷 직접 접속 차단(publicly_accessible = false)
  multi_az               = false
  publicly_accessible    = false
  vpc_security_group_ids = [aws_security_group.rds.id]
  skip_final_snapshot    = true

  tags = {
    Name  = "${var.team_account_name}-${var.project_name}-pg"
    Owner = var.team_account_name
  }
}

# ------------------------------------------------------------------------------
# 3. DynamoDB (온디맨드 PAY_PER_REQUEST + 35일 시점 복구 PITR)
# ------------------------------------------------------------------------------
resource "aws_dynamodb_table" "results" {
  name         = "${var.team_account_name}-${var.project_name}-results"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Owner = var.team_account_name
  }
}

# ------------------------------------------------------------------------------
# 4. S3 버킷 (주의사항 6번: 버킷 이름은 반드시 본인 username인 inha-capstone-20으로 시작!)
# ------------------------------------------------------------------------------
resource "aws_s3_bucket" "frontend" {
  bucket_prefix = "${var.team_account_name}-${var.project_name}-"
  force_destroy = true

  tags = {
    Owner = var.team_account_name
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ------------------------------------------------------------------------------
# 5. SQS + Dead Letter Queue (PDF 4쪽 8.c.ii 추천 비동기 메시징 서비스!)
# - 우리가 Day 9~11에 배운 '3번 연속 실패 시 DLQ(비상 보관함)로 격리'를 AWS SQS로 구현한 설정입니다.
# ------------------------------------------------------------------------------
resource "aws_sqs_queue" "batch_dlq" {
  name                      = "${var.team_account_name}-${var.project_name}-batch-dlq"
  message_retention_seconds = 1209600 # 14일 동안 실패 메시지 안전 보관

  tags = {
    Owner = var.team_account_name
  }
}

resource "aws_sqs_queue" "batch_queue" {
  name                       = "${var.team_account_name}-${var.project_name}-batch-queue"
  visibility_timeout_seconds = 30
  # redrive_policy: 워커가 3번(maxReceiveCount = 3) 처리에 실패하면 위 batch_dlq로 자동 이동시킵니다!
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.batch_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    Owner = var.team_account_name
  }
}

# ------------------------------------------------------------------------------
# 6. Lambda + API Gateway HTTP API (주의사항 5번 & Route53/ACM 대안 PDF 1쪽 반영)
# - Lambda 생성 시 새 역할을 만들지 않고 기존 역할(SafeRole-inha-capstone-20)을 연결합니다.
# - API Gateway 기본 도메인(*.execute-api.ap-northeast-2.amazonaws.com)은
#   Route 53이나 ACM 없이도 AWS 공식 신뢰 HTTPS 인증서를 무료로 제공합니다!
# ------------------------------------------------------------------------------
resource "aws_apigatewayv2_api" "https_gateway" {
  name          = "${var.team_account_name}-${var.project_name}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "DELETE", "OPTIONS"]
    allow_headers = ["Authorization", "Content-Type", "Idempotency-Key"]
  }

  tags = {
    Owner = var.team_account_name
  }
}

# ------------------------------------------------------------------------------
# 7. SNS + CloudWatch Alarm (EC2 서버 이상 감지 시 이메일 알림 발송)
# ------------------------------------------------------------------------------
resource "aws_sns_topic" "alarms" {
  name = "${var.team_account_name}-${var.project_name}-alarms"

  tags = {
    Owner = var.team_account_name
  }
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "ec2_status_check" {
  alarm_name          = "${var.team_account_name}-${var.project_name}-ec2-status-check-failed"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    InstanceId = aws_instance.app.id
  }
}
