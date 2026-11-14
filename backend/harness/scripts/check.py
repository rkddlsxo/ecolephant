"""Run backend contract, security, documentation-link and checker tests."""
import argparse
from pathlib import Path
import subprocess
import sys

from checks.common import ROOT, load, require
from checks.contracts import check_contracts
from checks.links import check_links
from checks.policy import check_policy
from checks.secrets import check_secrets


def self_tests():
    path = Path(__file__).resolve().parents[1] / 'tests'
    result = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', str(path), '-p', 'test_*.py'], cwd=ROOT)
    require(result.returncode == 0, 'Backend harness tests failed')


def main():
    checks = {
        'contracts': lambda: check_contracts(
            load('docs/api/openapi.json'),
            load('backend/harness/fixtures/policy/example.json'),
            load('backend/harness/fixtures/http/contract-cases.json')['cases'],
            {'change-v1': load('backend/harness/fixtures/policy/change-v1.json'),
             'change-v2': load('backend/harness/fixtures/policy/change-v2.json')},
        ),
        'policy': lambda: [check_policy(load(f'backend/harness/fixtures/policy/{name}.json'))
                           for name in ('example', 'change-v1', 'change-v2')],
        'links': check_links,
        'secrets': check_secrets,
        'self-tests': self_tests,
    }
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', choices=['all', *checks], default='all')
    args = parser.parse_args()
    failures = []
    selected = checks.items() if args.only == 'all' else [(args.only, checks[args.only])]
    for name, check in selected:
        try:
            check()
        except Exception as exc:
            failures.append(name)
            print(f'FAIL {name}: {exc}', file=sys.stderr)
    require(not failures, 'Failed checks: ' + ', '.join(failures))
    print('PASS backend harness. Device, real-model and deployment validation are separate.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'FAIL {exc}', file=sys.stderr)
        sys.exit(1)
