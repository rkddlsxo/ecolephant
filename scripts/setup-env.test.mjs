import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { configureLocalEnvironment } from './setup-env.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python =
  process.env.ECOLEPHANT_SETUP_TEST_PYTHON ||
  path.join(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const keys = [
  'ECOLEPHANT_AUTH_MODE',
  'ECOLEPHANT_LOCAL_TOKEN',
  'VITE_AUTH_MODE',
  'VITE_LOCAL_TOKEN',
  'SYNTHETIC_SETUP_TOKEN',
  'DEBUG',
];

function fixture(t) {
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'ecolephant-setup-test-'));
  t.after(() => {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    const safe = fs.realpathSync(root);
    assert.equal(path.dirname(safe), parent);
    assert.ok(path.basename(safe).startsWith('ecolephant-setup-test-'));
    fs.rmSync(safe, { recursive: true });
  });
  fs.mkdirSync(path.join(root, 'backend'));
  fs.mkdirSync(path.join(root, 'frontend'));
  fs.writeFileSync(
    path.join(root, 'backend/.env.example'),
    'ECOLEPHANT_AUTH_MODE=local\nECOLEPHANT_LOCAL_TOKEN=\n',
  );
  return root;
}

test('fresh setup creates matching files and a repeat preserves them', async (t) => {
  const root = fixture(t);
  await configureLocalEnvironment({ root, python });
  const backend = path.join(root, 'backend/.env');
  const frontend = path.join(root, 'frontend/.env.local');
  const before = [fs.readFileSync(backend, 'utf8'), fs.readFileSync(frontend, 'utf8')];
  assert.equal(parseEnv(before[0]).ECOLEPHANT_LOCAL_TOKEN, parseEnv(before[1]).VITE_LOCAL_TOKEN);
  await configureLocalEnvironment({ root, python });
  assert.deepEqual([fs.readFileSync(backend, 'utf8'), fs.readFileSync(frontend, 'utf8')], before);
});

test('different existing local tokens fail without changing or printing their contents', async (t) => {
  const root = fixture(t);
  const backend = path.join(root, 'backend/.env');
  const frontend = path.join(root, 'frontend/.env.local');
  const before = [
    'ECOLEPHANT_AUTH_MODE=local\nECOLEPHANT_LOCAL_TOKEN=backend-synthetic\n',
    'VITE_LOCAL_TOKEN=frontend-synthetic\n',
  ];
  fs.writeFileSync(backend, before[0]);
  fs.writeFileSync(frontend, before[1]);
  await assert.rejects(
    configureLocalEnvironment({ root, python }),
    (error) =>
      /설정/.test(error.message) &&
      !error.message.includes('backend-synthetic') &&
      !error.message.includes('frontend-synthetic'),
  );
  assert.deepEqual([fs.readFileSync(backend, 'utf8'), fs.readFileSync(frontend, 'utf8')], before);
});

test('uses effective process variables rather than only the file values', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'backend/.env'), 'ECOLEPHANT_LOCAL_TOKEN=file-backend\n');
  fs.writeFileSync(path.join(root, 'frontend/.env.local'), 'VITE_LOCAL_TOKEN=file-frontend\n');
  process.env.ECOLEPHANT_LOCAL_TOKEN = 'process-synthetic';
  process.env.VITE_LOCAL_TOKEN = 'process-synthetic';
  await configureLocalEnvironment({ root, python });
});

test('checks environment references using the same loaders as the running apps', async (t) => {
  const root = fixture(t);
  process.env.SYNTHETIC_SETUP_TOKEN = 'expanded-synthetic';
  fs.writeFileSync(
    path.join(root, 'backend/.env'),
    'ECOLEPHANT_LOCAL_TOKEN=${SYNTHETIC_SETUP_TOKEN}\n',
  );
  fs.writeFileSync(
    path.join(root, 'frontend/.env.local'),
    'VITE_LOCAL_TOKEN=${SYNTHETIC_SETUP_TOKEN}\n',
  );
  await configureLocalEnvironment({ root, python });
});

test('notices a higher-priority frontend development environment file', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'backend/.env'), 'ECOLEPHANT_LOCAL_TOKEN=first-synthetic\n');
  fs.writeFileSync(path.join(root, 'frontend/.env.local'), 'VITE_LOCAL_TOKEN=first-synthetic\n');
  fs.writeFileSync(
    path.join(root, 'frontend/.env.development.local'),
    'VITE_LOCAL_TOKEN=other-synthetic\n',
  );
  await assert.rejects(configureLocalEnvironment({ root, python }), /설정/);
});

test('keeps explicitly configured Cognito or preview without adding a local token', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'backend/.env'), 'ECOLEPHANT_LOCAL_TOKEN=backend-synthetic\n');
  fs.writeFileSync(path.join(root, 'frontend/.env.development'), 'VITE_AUTH_MODE=cognito\n');
  await configureLocalEnvironment({ root, python });
  assert.equal(fs.existsSync(path.join(root, 'frontend/.env.local')), false);
  fs.writeFileSync(path.join(root, 'frontend/.env.development'), 'VITE_AUTH_MODE=preview\n');
  await configureLocalEnvironment({ root, python });
  assert.equal(fs.existsSync(path.join(root, 'frontend/.env.local')), false);
});

test('keeps a cloud-only configuration without inventing a local token', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'backend/.env'), 'ECOLEPHANT_AUTH_MODE=cognito\n');
  fs.writeFileSync(path.join(root, 'frontend/.env.local'), 'VITE_AUTH_MODE=cognito\n');
  await configureLocalEnvironment({ root, python });
  assert.equal(
    fs.readFileSync(path.join(root, 'frontend/.env.local'), 'utf8'),
    'VITE_AUTH_MODE=cognito\n',
  );
});

test('does not persist a temporary backend environment token as the new frontend default', async (t) => {
  const root = fixture(t);
  process.env.ECOLEPHANT_LOCAL_TOKEN = 'temporary-synthetic';
  await assert.rejects(configureLocalEnvironment({ root, python }), /설정/);
  await assert.rejects(configureLocalEnvironment({ root, python }), /설정/);
  assert.equal(fs.existsSync(path.join(root, 'frontend/.env.local')), false);
  delete process.env.ECOLEPHANT_LOCAL_TOKEN;
  await configureLocalEnvironment({ root, python });
  const backend = parseEnv(fs.readFileSync(path.join(root, 'backend/.env'), 'utf8'));
  const frontend = parseEnv(fs.readFileSync(path.join(root, 'frontend/.env.local'), 'utf8'));
  assert.equal(backend.ECOLEPHANT_LOCAL_TOKEN, frontend.VITE_LOCAL_TOKEN);
});

test('does not create a broken frontend file for a custom token requiring special escaping', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'backend/.env'), 'ECOLEPHANT_LOCAL_TOKEN="synthetic#token"\n');
  await assert.rejects(configureLocalEnvironment({ root, python }), /직접/);
  assert.equal(fs.existsSync(path.join(root, 'frontend/.env.local')), false);
});

test('does not print token values even when Vite debugging is enabled', (t) => {
  const root = fixture(t);
  const token = 'synthetic-debug-value';
  fs.writeFileSync(path.join(root, 'backend/.env'), `ECOLEPHANT_LOCAL_TOKEN=${token}\n`);
  fs.writeFileSync(path.join(root, 'frontend/.env.local'), `VITE_LOCAL_TOKEN=${token}\n`);
  const moduleUrl = pathToFileURL(path.join(project, 'scripts/setup-env.mjs')).href;
  const script = `import { configureLocalEnvironment } from ${JSON.stringify(moduleUrl)}; await configureLocalEnvironment({root:process.argv[1],python:process.argv[2]});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, root, python], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, DEBUG: 'vite:*' },
    windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.ok(
    !result.stdout.includes(token) && !result.stderr.includes(token),
    'Token appeared in output',
  );
});
