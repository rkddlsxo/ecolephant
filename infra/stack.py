from aws_cdk import Stack, Duration, RemovalPolicy, CfnOutput
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from aws_cdk import aws_cognito as cognito
from aws_cdk import aws_apigatewayv2 as apigateway
from aws_cdk import aws_apigatewayv2_integrations as integrations
from aws_cdk import aws_apigatewayv2_authorizers as authorizers
from aws_cdk import aws_cloudwatch as cloudwatch
from constructs import Construct


class EcolephantStack(Stack):
    def __init__(self, scope: Construct, name: str, *, bundle, frontend_origin, **kwargs):
        super().__init__(scope, name, **kwargs)
        table = dynamodb.Table(self, "Results",
                               partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING),
                               sort_key=dynamodb.Attribute(name="sk", type=dynamodb.AttributeType.STRING),
                               billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
                               removal_policy=RemovalPolicy.RETAIN)
        pool = cognito.UserPool(self, "Owners", self_sign_up_enabled=False,
                                sign_in_aliases=cognito.SignInAliases(email=True),
                                password_policy=cognito.PasswordPolicy(min_length=12, require_digits=True,
                                                                        require_lowercase=True, require_uppercase=True, require_symbols=True),
                                removal_policy=RemovalPolicy.RETAIN)
        client = pool.add_client("WebClient", generate_secret=False,
                                 auth_flows=cognito.AuthFlow(user_srp=True),
                                 prevent_user_existence_errors=True)
        group = logs.LogGroup(self, "BackendLogs", retention=logs.RetentionDays.TWO_WEEKS,
                              removal_policy=RemovalPolicy.DESTROY)
        function = lambda_.Function(self, "Backend", runtime=lambda_.Runtime.PYTHON_3_12,
                                     architecture=lambda_.Architecture.X86_64,
                                     handler="lambda_handler.handler", code=lambda_.Code.from_asset(str(bundle)),
                                     timeout=Duration.seconds(29), memory_size=512, log_group=group,
                                     environment={"ECOLEPHANT_AUTH_MODE":"cognito", "ECOLEPHANT_STORAGE":"dynamodb",
                                                  "ECOLEPHANT_TABLE":table.table_name,
                                                  "ECOLEPHANT_JWT_ISSUER":pool.user_pool_provider_url,
                                                  "ECOLEPHANT_JWT_CLIENT_ID":client.user_pool_client_id,
                                                  "ECOLEPHANT_ALLOWED_ORIGIN":frontend_origin})
        table.grant_read_write_data(function)
        integration = integrations.HttpLambdaIntegration("Flask", function)
        api = apigateway.HttpApi(self, "Api", cors_preflight=apigateway.CorsPreflightOptions(
            allow_origins=[frontend_origin], allow_methods=[apigateway.CorsHttpMethod.GET,
                apigateway.CorsHttpMethod.POST, apigateway.CorsHttpMethod.DELETE],
            allow_headers=["Authorization", "Content-Type", "Idempotency-Key"]))
        jwt = authorizers.HttpJwtAuthorizer("CognitoJwt", pool.user_pool_provider_url,
                                            jwt_audience=[client.user_pool_client_id])
        api.add_routes(path="/health", methods=[apigateway.HttpMethod.GET], integration=integration)
        api.add_routes(path="/api/v1/{proxy+}", methods=[apigateway.HttpMethod.ANY],
                       integration=integration, authorizer=jwt)
        cloudwatch.Alarm(self, "BackendErrors", metric=function.metric_errors(period=Duration.minutes(5)),
                         threshold=5, evaluation_periods=1,
                         treat_missing_data=cloudwatch.TreatMissingData.NOT_BREACHING)
        CfnOutput(self, "ApiUrl", value=api.api_endpoint)
        CfnOutput(self, "UserPoolId", value=pool.user_pool_id)
        CfnOutput(self, "ClientId", value=client.user_pool_client_id)
        CfnOutput(self, "ResultsTable", value=table.table_name)
