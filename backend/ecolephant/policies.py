"""Validate deployment-supplied policy profiles and preserve the original draft."""

from copy import deepcopy
import hashlib
import json
import math

from jsonschema import Draft202012Validator

from .contracts import BASE, POLICY, SPEC, canonical
from .errors import ApiError

LEGACY_POLICY = json.loads((BASE / 'legacy-policy.json').read_text(encoding='utf-8'))
LEGACY_DIGEST = '1968fa6a4b99a53ea2ca7e7670f9b95882d6212f8bf70bd488f90c715e723914'
if hashlib.sha256(canonical(LEGACY_POLICY).encode('utf-8')).hexdigest() != LEGACY_DIGEST:
    raise RuntimeError('The original draft policy snapshot must not be modified')


def shape(example):
    if isinstance(example, dict):
        return {'type': 'object', 'properties': {key: shape(value) for key, value in example.items()},
                'required': list(example), 'additionalProperties': False}
    if isinstance(example, list):
        return {'type': 'array', 'items': {'type': 'string'}}
    if isinstance(example, bool):
        return {'type': 'boolean'}
    if isinstance(example, (int, float)):
        return {'type': 'number'}
    return {'type': 'string'}


SCHEMA = shape(LEGACY_POLICY)
summary = SPEC['components']['schemas']['PolicySummary']['properties']
for field in ('policy_id', 'revision', 'release_approved', 'camera_mapping_status'):
    SCHEMA['properties'][field] = summary[field]
# Optional fields of change-based profiles (draft-web-v1, DEC-002). Absent means angle-based.
BAND = {'type': 'object', 'properties': {'caution': {'type': 'number'}, 'high': {'type': 'number'}},
        'required': ['caution', 'high'], 'additionalProperties': False}
SCHEMA['properties']['camera_judgement'] = {'type': 'string', 'enum': ['angle', 'change']}
SCHEMA['properties']['camera_change_thresholds'] = {
    'type': 'object', 'properties': {'forward': BAND, 'drop': BAND, 'nose_drop': BAND},
    'required': ['forward', 'drop', 'nose_drop'], 'additionalProperties': False}


def validate_policy(value):
    try:
        canonical(value)
        if not Draft202012Validator(SCHEMA).is_valid(value):
            raise ValueError('Policy profile does not match the supported shape')
        thresholds, weights = value['thresholds_deg'], value['fusion_weights']
        if not (0 < thresholds['caution'] < thresholds['high'] <= 90):
            raise ValueError('Invalid posture thresholds')
        if not all(0 <= weight <= 1 for weight in weights.values()) or not math.isclose(sum(weights.values()), 1):
            raise ValueError('Invalid sensor weights')
        if value.get('camera_judgement') == 'change':
            bands = value.get('camera_change_thresholds')
            if not bands:
                raise ValueError('Change-based profile needs camera_change_thresholds')
            if not (0 < bands['forward']['caution'] < bands['forward']['high']):
                raise ValueError('Invalid forward change bounds')
            for name in ('drop', 'nose_drop'):
                if not (bands[name]['high'] < bands[name]['caution'] < 0):
                    raise ValueError('Invalid drop change bounds')
        elif 'camera_change_thresholds' in value:
            raise ValueError('Change thresholds need camera_judgement=change')
        if (value['quality']['window_ms'] != 1000 or value['transport']['batch_max_items'] != 60
                or value['transport']['batch_max_bytes'] != 65536 or value['alerts']['adaptive_reduction_enabled']):
            raise ValueError('Policy settings do not match the supported API')
        for section in ('calibration', 'quality', 'alerts', 'transport'):
            for item in value[section].values():
                if isinstance(item, (int, float)) and not isinstance(item, bool) and item <= 0:
                    raise ValueError('Policy timing and limits must be positive')
    except (TypeError, KeyError, OverflowError) as exc:
        raise ValueError('Invalid policy profile') from exc


def load_catalog(profiles=None):
    if profiles is None:
        profiles = [POLICY]
        for path in sorted((BASE / 'policies').glob('*.json')):
            profiles.append(json.loads(path.read_text(encoding='utf-8')))
    if not isinstance(profiles, list) or not profiles:
        raise ValueError('At least one policy profile is required')
    result = {}
    for profile in profiles:
        validate_policy(profile)
        name = profile['policy_id']
        if name in result:
            raise ValueError('Duplicate policy identifier')
        result[name] = deepcopy(profile)
    return result


def session_policy(record):
    policy = record.get('policy')
    if policy is None and record['session']['policy_id'] == LEGACY_POLICY['policy_id']:
        return LEGACY_POLICY
    if not isinstance(policy, dict) or policy.get('policy_id') != record['session']['policy_id']:
        raise ApiError(503, 'policy_snapshot_missing', '기록의 정책을 확인할 수 없습니다.')
    return policy
