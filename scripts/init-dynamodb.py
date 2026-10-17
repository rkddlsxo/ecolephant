"""Initialize the optional local single table; refuses to initialize a cloud endpoint."""
import os
from pathlib import Path
from urllib.parse import urlparse

import boto3
from dotenv import load_dotenv
from botocore.exceptions import ClientError

load_dotenv(Path(__file__).resolve().parents[1] / "backend/.env")
endpoint = os.getenv("AWS_ENDPOINT_URL_DYNAMODB", "http://localhost:8000")
if urlparse(endpoint).hostname not in {"localhost", "127.0.0.1", "dynamodb"}:
    raise SystemExit("This initializer only supports DynamoDB Local")
client = boto3.client("dynamodb", endpoint_url=endpoint, region_name="ap-northeast-2",
                      aws_access_key_id="local", aws_secret_access_key="local")
try:
    client.create_table(TableName=os.getenv("ECOLEPHANT_TABLE", "ecolephant-local"),
                        KeySchema=[{"AttributeName":"pk", "KeyType":"HASH"}, {"AttributeName":"sk", "KeyType":"RANGE"}],
                        AttributeDefinitions=[{"AttributeName":"pk", "AttributeType":"S"}, {"AttributeName":"sk", "AttributeType":"S"}],
                        BillingMode="PAY_PER_REQUEST")
    print("Local table created")
except ClientError as error:
    if error.response["Error"]["Code"] != "ResourceInUseException":
        raise
    print("Local table already exists")
