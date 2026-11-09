# terraform apply 완료시 출력되는 role arn으로, 이 값을 github variables의 aws_role_arn에 넣으면 액세스 키 없는 배포가 동작합니다.
output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.github.arn
}

output "deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}
