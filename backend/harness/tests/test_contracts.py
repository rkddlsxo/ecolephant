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

    def test_http_examples_match_the_contract(self):
        contracts.check_contracts(self.spec, self.policy, self.cases)

    def test_raw_frame_property_is_rejected(self):
        spec = deepcopy(self.spec)
        spec['components']['schemas']['SampleWindow']['properties']['frame'] = {'type': 'string'}
        with self.assertRaisesRegex(ValueError, 'Forbidden raw/private field'):
            contracts.check_contracts(spec, self.policy, self.cases)

    def test_invalid_expected_shape_is_reported(self):
        cases = deepcopy(self.cases)
        cases[0]['valid'] = not cases[0]['valid']
        with self.assertRaisesRegex(ValueError, 'schema expectation failed'):
            contracts.check_contracts(self.spec, self.policy, cases)
