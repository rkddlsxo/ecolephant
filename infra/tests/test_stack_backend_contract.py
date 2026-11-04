"""Synthesize a disposable CDK template without AWS credentials or deployment."""

from pathlib import Path
import json
import sys
import tempfile
import unittest

import aws_cdk as cdk
from aws_cdk.assertions import Template

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stack import EcolephantStack  # noqa: E402


class StackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='ecolephant-cdk-test-')
        root = Path(cls.temporary.name)
        bundle = root / 'bundle'
        bundle.mkdir()
        (bundle / 'lambda_handler.py').write_text('def handler(event, context): return {}\n', encoding='utf-8')
        app = cdk.App(outdir=str(root / 'assembly'))
        stack = EcolephantStack(app, 'SyntheticTest', bundle=bundle,
                                frontend_origin='https://frontend.example.test',
                                env=cdk.Environment(account='111111111111', region='ap-northeast-2'))
        cls.resources = Template.from_stack(stack).to_json()['Resources']

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def resources_of(self, kind):
        return [(name, item) for name, item in self.resources.items() if item['Type'] == kind]

    def test_user_pool_enables_srp_without_placeholder_oauth(self):
        _, pool = self.resources_of('AWS::Cognito::UserPool')[0]
        self.assertTrue(pool['Properties']['AdminCreateUserConfig']['AllowAdminCreateUserOnly'])
        _, client = self.resources_of('AWS::Cognito::UserPoolClient')[0]
        props = client['Properties']
        self.assertFalse(props['GenerateSecret'])
        self.assertEqual(set(props['ExplicitAuthFlows']), {'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'})
        self.assertFalse(props.get('AllowedOAuthFlowsUserPoolClient', False))
        self.assertNotIn('AllowedOAuthFlows', props)
        self.assertNotIn('CallbackURLs', props)

    def test_api_protects_product_routes_with_cognito_jwt(self):
        routes = {item['Properties']['RouteKey']: item['Properties']
                  for _, item in self.resources_of('AWS::ApiGatewayV2::Route')}
        self.assertEqual(routes['GET /health']['AuthorizationType'], 'NONE')
        self.assertEqual(routes['ANY /api/v1/{proxy+}']['AuthorizationType'], 'JWT')
        authorizers = self.resources_of('AWS::ApiGatewayV2::Authorizer')
        self.assertEqual(len(authorizers), 1)
        authorizer_name, authorizer = authorizers[0]
        self.assertEqual(routes['ANY /api/v1/{proxy+}']['AuthorizerId'], {'Ref': authorizer_name})
        self.assertEqual(authorizer['Properties']['IdentitySource'], ['$request.header.Authorization'])
        self.assertEqual(authorizer['Properties']['AuthorizerType'], 'JWT')
        permissions = self.resources_of('AWS::Lambda::Permission')
        self.assertTrue(permissions)
        self.assertTrue(all(item['Properties']['Principal'] == 'apigateway.amazonaws.com' and
                            'execute-api:' in json.dumps(item['Properties']['SourceArn'])
                            for _, item in permissions))

    def test_lambda_environment_cors_and_dynamodb_grants(self):
        table_name, table = self.resources_of('AWS::DynamoDB::Table')[0]
        self.assertEqual(table['Properties']['BillingMode'], 'PAY_PER_REQUEST')
        self.assertEqual(table.get('DeletionPolicy'), 'Retain')
        _, function = self.resources_of('AWS::Lambda::Function')[0]
        props = function['Properties']
        self.assertEqual(props['Runtime'], 'python3.12')
        env = props['Environment']['Variables']
        self.assertEqual(env['ECOLEPHANT_AUTH_MODE'], 'cognito')
        self.assertEqual(env['ECOLEPHANT_STORAGE'], 'dynamodb')
        self.assertEqual(env['ECOLEPHANT_TABLE'], {'Ref': table_name})
        self.assertEqual(env['ECOLEPHANT_ALLOWED_ORIGIN'], 'https://frontend.example.test')
        _, api = self.resources_of('AWS::ApiGatewayV2::Api')[0]
        cors = api['Properties']['CorsConfiguration']
        self.assertEqual(cors['AllowOrigins'], ['https://frontend.example.test'])
        self.assertEqual(set(cors['AllowMethods']), {'GET', 'POST', 'DELETE'})
        statements = [statement for _, resource in self.resources_of('AWS::IAM::Policy')
                      for statement in resource['Properties']['PolicyDocument']['Statement']]
        table_statements = [s for s in statements if table_name in json.dumps(s.get('Resource'))]
        actions = {action for statement in table_statements for action in statement['Action']}
        self.assertTrue({'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query',
                         'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'} <= actions)
        self.assertNotIn('dynamodb:*', actions)
