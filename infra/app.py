from pathlib import Path
import os

import aws_cdk as cdk
from stack import EcolephantStack

app = cdk.App()
bundle = Path(__file__).resolve().parents[1] / ".build/lambda"
if not (bundle / "lambda_handler.py").exists():
    raise RuntimeError("Package the Lambda asset first: npm run lambda:package")
EcolephantStack(app, "EcolephantMvp", bundle=bundle,
               frontend_origin=app.node.try_get_context("frontendOrigin"),
               env=cdk.Environment(account=os.getenv("CDK_DEFAULT_ACCOUNT"), region="ap-northeast-2"))
cdk.Tags.of(app).add("Project", "ecolephant")
cdk.Tags.of(app).add("Owner", app.node.try_get_context("owner") or "ecolephant-team")
app.synth()
