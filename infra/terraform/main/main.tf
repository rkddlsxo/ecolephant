data "aws_vpc" "default" {
  default = true
}

# ami id를 하드코딩 하지 않고 canonical 공식 계정에서 가장 최신 ubuntu 24.04 tls arm64이미지를 자동으로 찾아옵니다.
data "aws_ami" "ubuntu_arm64" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ec2 백엔드에서 사용할 dynamo db 테이블을 생성합니다. 이 테이블은 posture 결과를 저장하는 데 사용됩니다.
resource "aws_dynamodb_table" "results" {
  name = "${var.project_name}-results"
  # 상시 과금이 없는 온디맨드 모드로, 요청한 만큼만 과금되어 월 $0.1 미만으로 유지됩니다.
  billing_mode = "PAY_PER_REQUEST"
  # 백엔드의 단일 테이블 설계와 정확히 일치하는 파티션 키.정렬 키입니다.
  hash_key  = "pk"
  range_key = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # 실수로 데이터를 지워도 최근 35일 내 원하는 초 단위로 복구할 수 있는 PIRT 기능입니다.
  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

# cognito 사용자 풀
resource "aws_cognito_user_pool" "owners" {
  name                     = "${var.project_name}-owners"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # 아무나 회원가입하지 못하고 관리자(팀)가 생성한 시연.테스트 계정만 로그인할 수 있게 막습니다.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_numbers   = true
    require_symbols   = true
    require_uppercase = true
  }
}

# 브라우저에서 직접 로그인하므로 client secret없이 안전한 SRP인증만 허용합니다.
resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${var.project_name}-web-client"
  user_pool_id                         = aws_cognito_user_pool.owners.id
  generate_secret                      = false
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  allowed_oauth_flows_user_pool_client = false
}

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2_backend" {
  name               = "${var.project_name}-ec2-backend-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

data "aws_iam_policy_document" "ec2_dynamodb_access" {
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:BatchWriteItem",
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.results.arn]
  }
}

# 서버에 aws키를 두지 않는 핵심
# ec2용 iam instance profile
resource "aws_iam_role_policy" "ec2_dynamodb_access" {
  name   = "${var.project_name}-ec2-dynamodb-policy"
  role   = aws_iam_role.ec2_backend.id
  policy = data.aws_iam_policy_document.ec2_dynamodb_access.json
}

resource "aws_iam_instance_profile" "ec2_backend" {
  name = "${var.project_name}-ec2-instance-profile"
  role = aws_iam_role.ec2_backend.name
}

# 외부에서는 웹(80/443)과 ansible배포용 ssh(22)만 열고 내부 컨테이너 포트는 차단하는 보안그룹
resource "aws_security_group" "app" {
  name   = "${var.project_name}-app-sg"
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
}

# ssh_public_key 변수가 주어졌을 때만 (count=1) ec2 점속용 키페어를 등록
resource "aws_key_pair" "deployer" {
  count      = var.ssh_public_key != "" ? 1 : 0
  key_name   = "${var.project_name}-deployer-key"
  public_key = var.ssh_public_key
}

# docker compose와 alloy관측 스택이 올라갈 ubuntu 24.04 ARM64 애플리케이션 서버
resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu_arm64.id
  instance_type               = var.instance_type
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2_backend.name
  key_name                    = var.ssh_public_key != "" ? aws_key_pair.deployer[0].key_name : null
  associate_public_ip_address = true

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  # 도커 이미지와 14일치 로그.메트릭 보관을 위한 20GB 암호화
  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name = "${var.project_name}-app-server"
  }
}

resource "aws_s3_bucket" "frontend" {
  bucket_prefix = "${var.project_name}-frontend-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project_name}-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# 정적 웹 자산을 HTTPS로 서빙하고 SPA라우팅을 처리하는 cloudfront CDN
resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "frontend_bucket_policy" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket_policy.json
}

resource "aws_sns_topic" "alarms" {
  name = "${var.project_name}-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "ec2_status_check" {
  alarm_name          = "${var.project_name}-ec2-status-check-failed"
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

