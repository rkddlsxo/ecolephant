from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"infra"))

import aws_cdk as cdk
from aws_cdk.assertions import Match, Template
from stack import EcolephantStack

ORIGIN="https://app.example.test"
# 비용이 큰 리소스. 크레딧이 $50이므로 한 종이라도 들어오면 테스트가 막는다.
FORBIDDEN=["AWS::EC2::NatGateway","AWS::EC2::VPC","AWS::EC2::EIP","AWS::RDS::DBInstance",
           "AWS::RDS::DBCluster","AWS::EKS::Cluster","AWS::ECS::Cluster",
           "AWS::ElasticLoadBalancingV2::LoadBalancer","AWS::ApiGateway::RestApi"]


class StackTemplate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Lambda 자산은 디렉터리 하나로 충분하다. npm run lambda:package 없이도 돌아간다.
        cls.bundle=tempfile.TemporaryDirectory(prefix="lambda-asset-")
        (Path(cls.bundle.name)/"lambda_handler.py").write_text("def handler(event, context):\n    return {}\n",encoding="utf-8")
        app=cdk.App()
        cls.stack=EcolephantStack(app,"TestStack",bundle=Path(cls.bundle.name),frontend_origin=ORIGIN)
        cls.template=Template.from_stack(cls.stack)
        cls.json=cls.template.to_json()

    @classmethod
    def tearDownClass(cls):
        cls.bundle.cleanup()

    def resource(self,kind):
        found=[v for v in self.json["Resources"].values() if v["Type"]==kind]
        self.assertEqual(len(found),1,f"{kind} 가 1개가 아니다: {len(found)}")
        return found[0]

    def test_table_is_on_demand_and_retained(self):
        """온디맨드가 아니면 쓰지 않아도 시간당 과금이 발생한다. 측정 결과는 실수로 지워지면 복구할 수 없다."""
        self.template.has_resource_properties("AWS::DynamoDB::Table",{
            "BillingMode":"PAY_PER_REQUEST",
            "KeySchema":[{"AttributeName":"pk","KeyType":"HASH"},{"AttributeName":"sk","KeyType":"RANGE"}],
            "ProvisionedThroughput":Match.absent()})
        table=self.resource("AWS::DynamoDB::Table")
        self.assertEqual(table.get("DeletionPolicy"),"Retain")
        self.assertEqual(table.get("UpdateReplacePolicy"),"Retain")

    def test_log_retention_is_two_weeks(self):
        """보관 기간을 지우면 로그가 무기한 쌓여 비용이 계속 증가한다."""
        self.template.has_resource_properties("AWS::Logs::LogGroup",{"RetentionInDays":14})

    def test_function_runtime_and_limits(self):
        """런타임·핸들러·타임아웃은 배포 계약이다. 29초는 HTTP API 통합 상한(30초)보다 작아야 한다."""
        self.template.has_resource_properties("AWS::Lambda::Function",{
            "Runtime":"python3.12","Handler":"lambda_handler.handler",
            "Timeout":29,"MemorySize":512,"Architectures":["x86_64"]})
        self.assertLess(self.resource("AWS::Lambda::Function")["Properties"]["Timeout"],30)

    def test_function_stays_outside_vpc(self):
        """VPC에 붙이면 NAT Gateway(월 약 $35)가 필요해진다. 계획서는 VPC 없는 Lambda를 전제한다."""
        self.template.has_resource_properties("AWS::Lambda::Function",{"VpcConfig":Match.absent()})

    def test_function_environment_is_wired(self):
        """테이블·발급자·오리진이 비어 있으면 배포는 성공하고 런타임에서만 깨진다."""
        env=self.resource("AWS::Lambda::Function")["Properties"]["Environment"]["Variables"]
        self.assertEqual(env["ECOLEPHANT_AUTH_MODE"],"cognito")
        self.assertEqual(env["ECOLEPHANT_STORAGE"],"dynamodb")
        self.assertEqual(env["ECOLEPHANT_ALLOWED_ORIGIN"],ORIGIN)
        for key in ("ECOLEPHANT_TABLE","ECOLEPHANT_JWT_ISSUER","ECOLEPHANT_JWT_CLIENT_ID"):
            self.assertIn(key,env,f"{key} 가 함수 환경변수에서 빠졌다")

    def test_no_expensive_resources(self):
        """상시 과금 리소스가 들어오면 크레딧 $50으로 학기를 못 버틴다."""
        present=sorted({v["Type"] for v in self.json["Resources"].values()} & set(FORBIDDEN))
        self.assertEqual(present,[],f"비용이 큰 리소스가 추가됐다: {present}")

    def test_public_route_is_only_health(self):
        """인증 없이 열리는 경로는 /health 하나여야 한다. 나머지는 Cognito JWT를 거친다."""
        routes={v["Properties"]["RouteKey"]:v["Properties"] for v in self.json["Resources"].values()
                if v["Type"]=="AWS::ApiGatewayV2::Route"}
        self.assertEqual(set(routes),{"GET /health","ANY /api/v1/{proxy+}"})
        self.assertNotIn("AuthorizerId",routes["GET /health"])
        self.assertEqual(routes["ANY /api/v1/{proxy+}"]["AuthorizationType"],"JWT")
        self.assertIn("AuthorizerId",routes["ANY /api/v1/{proxy+}"])

    def test_authorizer_checks_audience(self):
        """audience 검증이 빠지면 다른 사용자 풀이 발급한 토큰도 통과한다."""
        self.template.has_resource_properties("AWS::ApiGatewayV2::Authorizer",{
            "AuthorizerType":"JWT","IdentitySource":["$request.header.Authorization"],
            "JwtConfiguration":{"Audience":Match.any_value()}})

    def test_cors_allows_only_the_frontend_origin(self):
        """와일드카드 오리진은 브라우저에서 임의 사이트가 API를 호출할 수 있게 만든다."""
        cors=self.resource("AWS::ApiGatewayV2::Api")["Properties"]["CorsConfiguration"]
        self.assertEqual(cors["AllowOrigins"],[ORIGIN])
        self.assertNotIn("*",cors["AllowOrigins"])
        self.assertEqual(sorted(cors["AllowMethods"]),["DELETE","GET","POST"])

    def test_user_pool_blocks_self_signup(self):
        """공개 가입이 열리면 모르는 사용자가 계정을 만들 수 있다."""
        self.template.has_resource_properties("AWS::Cognito::UserPool",{
            "AdminCreateUserConfig":{"AllowAdminCreateUserOnly":True},
            "UsernameAttributes":["email"],
            "Policies":{"PasswordPolicy":{"MinimumLength":12,"RequireNumbers":True,
                                          "RequireLowercase":True,"RequireUppercase":True,"RequireSymbols":True}}})

    def test_client_uses_srp_without_secret(self):
        """브라우저 앱은 비밀값을 숨길 수 없고, 비밀번호 직접 전달 흐름은 쓰지 않는다."""
        props=self.resource("AWS::Cognito::UserPoolClient")["Properties"]
        self.assertNotEqual(props.get("GenerateSecret"),True)
        self.assertIn("ALLOW_USER_SRP_AUTH",props["ExplicitAuthFlows"])
        for flow in ("ALLOW_USER_PASSWORD_AUTH","ALLOW_ADMIN_USER_PASSWORD_AUTH","ALLOW_CUSTOM_AUTH"):
            self.assertNotIn(flow,props["ExplicitAuthFlows"])
        self.assertEqual(props["PreventUserExistenceErrors"],"ENABLED")

    def test_error_alarm_exists(self):
        """알람이 없으면 함수가 계속 실패해도 아무도 모른다."""
        self.template.has_resource_properties("AWS::CloudWatch::Alarm",{
            "Namespace":"AWS/Lambda","MetricName":"Errors","Period":300,
            "Threshold":5,"EvaluationPeriods":1,"TreatMissingData":"notBreaching"})

    def test_outputs_for_frontend_wiring(self):
        """프론트 연결에 필요한 값은 출력으로 꺼내 둬야 콘솔을 뒤지지 않는다."""
        self.assertEqual(set(self.json["Outputs"]),{"ApiUrl","UserPoolId","ClientId","ResultsTable"})


if __name__=="__main__":
    unittest.main()
