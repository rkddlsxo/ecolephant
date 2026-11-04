from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import OpenAPIV31SpecValidator

from .common import check_refs, require, walk
from .semantics import semantic_errors


def check_contracts(spec, policy, cases):
    errors = list(OpenAPIV31SpecValidator(spec).iter_errors())
    require(not errors, 'OpenAPI error: ' + '; '.join(str(e)[:700] for e in errors[:3]))
    check_refs(spec)
    for schema in spec['components']['schemas'].values():
        Draft202012Validator.check_schema(schema)
    forbidden = {
        'image', 'images', 'frame', 'frames', 'video', 'landmarks', 'raw_imu',
        'rotation_rate_rad_s', 'pitch_rad', 'roll_rad', 'baseline_landmarks', 'owner_id',
    }
    for node in walk(spec['components']['schemas']):
        require(not (forbidden & set(node.get('properties', {}))), 'Forbidden raw/private field in REST contract')
        if node.get('type') == 'object':
            require(node.get('additionalProperties') is False, 'Every payload object must reject extra properties')
    for route, methods in spec['paths'].items():
        for method, operation in methods.items():
            if method in {'get', 'post', 'put', 'delete', 'patch'} and route != '/health':
                require(bool(operation.get('security', spec.get('security'))), f'Missing auth: {route}')
    require(any(case['valid'] for case in cases) and any(not case['valid'] for case in cases), 'Need valid and invalid fixtures')
    for case in cases:
        envelope = {'$ref': '#/components/schemas/' + case['schema'], 'components': spec['components']}
        validator = Draft202012Validator(envelope, format_checker=FormatChecker())
        shape_errors = list(validator.iter_errors(case['value']))
        valid = not shape_errors
        message = str(shape_errors[0])[:500] if shape_errors else 'unexpected acceptance'
        require(valid == case['valid'], f'{case["id"]} schema expectation failed: {message}')
        if valid:
            meanings = semantic_errors(case['schema'], case['value'], policy)
            require((not meanings) == case['semantics_valid'], f'{case["id"]} semantic expectation failed: {meanings}')
    print(f'PASS backend contracts: OpenAPI 3.1, {len(spec["components"]["schemas"])} schemas, {len(cases)} examples')
