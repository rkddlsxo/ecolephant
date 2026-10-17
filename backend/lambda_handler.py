from apig_wsgi import make_lambda_handler
from ecolephant import create_app

handler = make_lambda_handler(create_app(), binary_support=True)
