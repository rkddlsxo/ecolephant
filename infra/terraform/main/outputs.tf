# 배포 완료 후 ansible 인벤토리(ec2 공인 ip)와 프론트엔드 환경변수 (cognito, cloudfront)에 연결할 출력값
output "ec2_public_ip" {
  value = aws_instance.app.public_ip
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.results.name
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.owners.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "frontend_bucket_name" {
  value = aws_s3_bucket.frontend.bucket
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.frontend.domain_name
}

