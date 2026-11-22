# 배포 완료 후 확인할 핵심 AWS 리소스 주소 출력값
output "ec2_public_ip" {
  value = aws_instance.app.public_ip
}

output "rds_postgres_endpoint" {
  value = aws_db_instance.postgres.endpoint
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.results.name
}

output "frontend_bucket_name" {
  value = aws_s3_bucket.frontend.bucket
}

output "sqs_batch_queue_url" {
  value = aws_sqs_queue.batch_queue.id
}

output "sqs_batch_dlq_url" {
  value = aws_sqs_queue.batch_dlq.id
}

output "api_gateway_https_endpoint" {
  value = aws_apigatewayv2_api.https_gateway.api_endpoint
}
