# aws iam에 github actions 토큰 발급 서버를 신뢰할 수 있는 OIDC공급자로 등록합니다.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# 누가 이 role을 빌려 쓸 수 있는지 검사하는 보안 문지기
data "aws_iam_policy_document" "github_actions_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    # 첫번째 조건: 토큰 수신처(aud)가 sts.amazonaws.com인지 확인
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # 두번째 조건: 토큰 발행주체(iss)가 반드시 우리 저장소(리포지토리)에서 발행된 것인지 확인
    # 타인의 github 저장소에서 우리 aws계정에 접근하는 것을 원천 차단
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repository}:ref:refs/heads/${var.allowed_branch}",
        "repo:${var.github_repository}:pull_request",
      ]
    }
  }
}

# 위 신뢰 정책을 적용해 배포용 iamrole을 만들고, 임시 자격증명 유효시간을 1시간(3600초)로 제한합니다.
resource "aws_iam_role" "github_deploy" {
  name                 = var.role_name
  assume_role_policy   = data.aws_iam_policy_document.github_actions_assume_role.json
  max_session_duration = 3600
}

# github actions 배포 role에 부여할 최소 권한 정책 정의
# 우리 아키텍쳐에 필요한 핵심 aws 서비스 (ec2, dynamoDB, S3, cloudfront, cognito, cloudwatch) 권한만 허용
data "aws_iam_policy_document" "deploy_permissions" {
  statement {
    sid    = "EcolephantInfraManagement"
    effect = "Allow"
    actions = [
      "ec2:*",
      "dynamodb:*",
      "s3:*",
      "cloudfront:*",
      "cognito-idp:*",
      "cloudwatch:*",
      "logs:*",
      "sns:*",
      "budgets:ViewBudget",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  # 권한 상승 공격을 막기 위해 IAM role 조작은 오직 ecoleplant-* 접두사 리소스로만 제한
  statement {
    sid    = "EcolephantInstanceProfileBinding"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:PassRole",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
    ]
    resources = [
      "arn:aws:iam::*:role/ecolephant-*",
      "arn:aws:iam::*:instance-profile/ecolephant-*",
    ]
  }
}

#위 최소 권한 정책을 github_deploy_Role에 최종 연결
resource "aws_iam_role_policy" "deploy_permissions" {
  name   = "${var.role_name}-policy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.deploy_permissions.json
}
