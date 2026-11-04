import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildLambda } from './lambda-package-lib.mjs';

function fixture(t) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const repo = fs.mkdtempSync(path.join(tempRoot, 'ecolephant-package-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(repo);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith('ecolephant-package-test-'));
    fs.rmSync(resolved, { recursive: true });
  });
  fs.mkdirSync(path.join(repo, 'backend/ecolephant/contracts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'backend/lambda_handler.py'), 'handler v1');
  fs.writeFileSync(path.join(repo, 'backend/ecolephant/service.py'), 'service v1');
  fs.writeFileSync(path.join(repo, 'backend/ecolephant/contracts/policy.json'), '{}');
  return repo;
}

const install = (target) => fs.writeFileSync(path.join(target, 'dependency.py'), 'dependency');

test('rebuild drops removed sources and preserves required contracts', (t) => {
  const repo = fixture(t);
  const target = buildLambda(repo, install);
  assert.equal(
    fs.readFileSync(path.join(target, 'ecolephant/contracts/policy.json'), 'utf8'),
    '{}',
  );
  fs.unlinkSync(path.join(repo, 'backend/ecolephant/service.py'));
  fs.writeFileSync(path.join(repo, 'backend/ecolephant/new.py'), 'new code');
  buildLambda(repo, install);
  assert.equal(fs.existsSync(path.join(target, 'ecolephant/service.py')), false);
  assert.equal(fs.readFileSync(path.join(target, 'ecolephant/new.py'), 'utf8'), 'new code');
});

test('failed install preserves last working package', (t) => {
  const repo = fixture(t);
  const target = buildLambda(repo, install);
  assert.throws(() =>
    buildLambda(repo, () => {
      throw new Error('installation failed');
    }),
  );
  assert.equal(fs.readFileSync(path.join(target, 'ecolephant/service.py'), 'utf8'), 'service v1');
  assert.deepEqual(fs.readdirSync(path.join(repo, '.build')).sort(), ['lambda']);
});

test('unowned output is never replaced', (t) => {
  const repo = fixture(t);
  const target = path.join(repo, '.build/lambda');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'user-file.txt'), 'keep');
  assert.throws(() => buildLambda(repo, install), /owned|소유/);
  assert.equal(fs.readFileSync(path.join(target, 'user-file.txt'), 'utf8'), 'keep');
});

test('only runtime code and contracts are copied, excluding hidden or non-runtime files', (t) => {
  const repo = fixture(t);
  const source = path.join(repo, 'backend/ecolephant');
  fs.writeFileSync(path.join(source, '.env'), 'private');
  fs.writeFileSync(path.join(source, 'secret.pem'), 'private');
  fs.mkdirSync(path.join(source, '__pycache__'));
  fs.writeFileSync(path.join(source, '__pycache__/cached.pyc'), 'private');
  fs.symlinkSync(path.join(repo, 'backend'), path.join(source, 'linked-directory'), 'junction');
  const target = buildLambda(repo, install);
  assert.equal(fs.existsSync(path.join(target, 'ecolephant/.env')), false);
  assert.equal(fs.existsSync(path.join(target, 'ecolephant/secret.pem')), false);
  assert.equal(fs.existsSync(path.join(target, 'ecolephant/__pycache__')), false);
  assert.equal(fs.existsSync(path.join(target, 'ecolephant/linked-directory')), false);
  assert.equal(fs.existsSync(path.join(target, 'ecolephant/contracts/policy.json')), true);
});
