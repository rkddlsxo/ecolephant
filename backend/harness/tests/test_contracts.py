from copy import deepcopy
import importlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
common = importlib.import_module('checks.common')
contracts = importlib.import_module('checks.contracts')


class ContractChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = common.load('docs/api/openapi.json')
        cls.policy = common.load('backend/harness/fixtures/policy/example.json')
        cls.cases = common.load('backend/harness/fixtures/http/contract-cases.json')['cases']
        cls.profiles = {'change-v1': common.load('backend/harness/fixtures/policy/change-v1.json')}

    def test_http_examples_match_the_contract(self):
        contracts.check_contracts(self.spec, self.policy, self.cases, self.profiles)

    def test_raw_frame_property_is_rejected(self):
        spec = deepcopy(self.spec)
        spec['components']['schemas']['SampleWindow']['properties']['frame'] = {'type': 'string'}
        with self.assertRaisesRegex(ValueError, 'Forbidden raw/private field'):
            contracts.check_contracts(spec, self.policy, self.cases, self.profiles)

    def test_invalid_expected_shape_is_reported(self):
        cases = deepcopy(self.cases)
        cases[0]['valid'] = not cases[0]['valid']
        with self.assertRaisesRegex(ValueError, 'schema expectation failed'):
            contracts.check_contracts(self.spec, self.policy, cases, self.profiles)


class ChangeProfileChecks(unittest.TestCase):
    def test_change_case_without_profile_fails_closed(self):
        spec = common.load('docs/api/openapi.json')
        policy = common.load('backend/harness/fixtures/policy/example.json')
        cases = [case for case in common.load('backend/harness/fixtures/http/contract-cases.json')['cases']]
        with self.assertRaisesRegex(ValueError, 'unknown policy fixture'):
            contracts.check_contracts(spec, policy, cases)
