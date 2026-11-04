import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function createIfAbsent(file, content) {
  try {
    fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

function readBackend(root, python, file) {
  const script = [
    'import json, os, sys',
    'from dotenv import load_dotenv, dotenv_values',
    'file_token = dotenv_values(sys.argv[1], interpolate=False).get("ECOLEPHANT_LOCAL_TOKEN") or ""',
    'load_dotenv(sys.argv[1], override=False)',
    'print(json.dumps({"mode": os.getenv("ECOLEPHANT_AUTH_MODE", "local"), "token": os.getenv("ECOLEPHANT_LOCAL_TOKEN", ""), "fileToken": file_token}))',
  ].join('\n');
  const result = spawnSync(python, ['-c', script, file], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('백엔드 환경 설정을 읽지 못했습니다.');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('백엔드 환경 설정을 읽지 못했습니다.');
  }
}

function readFrontend(root, token) {
  const script = `
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const { loadEnv } = await import(input.vite);
    const values = loadEnv('development', input.directory);
    const explicitMode = values.VITE_AUTH_MODE || '';
    const actualToken = values.VITE_LOCAL_TOKEN || '';
    process.stdout.write(JSON.stringify({
      explicitMode,
      mode: explicitMode || (actualToken ? 'local' : 'preview'),
      tokenPresent: Boolean(actualToken),
      matches: actualToken.trim() === input.token,
    }));
  `;
  const env = { ...process.env };
  delete env.DEBUG;
  delete env.VITE_DEBUG_FILTER;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    input: JSON.stringify({
      directory: path.join(root, 'frontend'),
      token,
      vite: import.meta.resolve('vite'),
    }),
  });
  if (result.status !== 0) throw new Error('프론트 환경 설정을 읽지 못했습니다.');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('프론트 환경 설정을 읽지 못했습니다.');
  }
}

export async function configureLocalEnvironment({ root, python }) {
  const backendFile = path.join(root, 'backend/.env');
  const frontendFile = path.join(root, 'frontend/.env.local');
  if (!fs.existsSync(backendFile)) {
    const example = fs.readFileSync(path.join(root, 'backend/.env.example'), 'utf8');
    if (!/^ECOLEPHANT_LOCAL_TOKEN=$/m.test(example))
      throw new Error('백엔드 예제 설정을 확인해 주세요.');
    const token = crypto.randomBytes(32).toString('hex');
    createIfAbsent(
      backendFile,
      example.replace(/^ECOLEPHANT_LOCAL_TOKEN=$/m, `ECOLEPHANT_LOCAL_TOKEN=${token}`),
    );
  }
  const backend = readBackend(root, python, backendFile);
  if (!['local', 'cognito'].includes(backend.mode))
    throw new Error('백엔드 인증 설정을 확인해 주세요.');
  if (backend.mode === 'local' && !backend.token)
    throw new Error('백엔드 로컬 토큰 설정을 확인해 주세요.');
  let frontend = readFrontend(root, backend.token);
  if (!['', 'local', 'preview', 'cognito'].includes(frontend.explicitMode))
    throw new Error('프론트 인증 설정을 확인해 주세요.');
  if (
    !fs.existsSync(frontendFile) &&
    !frontend.tokenPresent &&
    !['preview', 'cognito'].includes(frontend.explicitMode)
  ) {
    if (backend.mode !== 'local') throw new Error('프론트 인증 설정을 직접 확인해 주세요.');
    if (!/^[A-Za-z0-9._~+/=-]+$/.test(backend.fileToken))
      throw new Error('특수 문자가 포함된 로컬 토큰은 프론트 환경 파일에 직접 설정해 주세요.');
    if (backend.token !== backend.fileToken)
      throw new Error('실행 환경의 백엔드 인증 설정을 확인한 뒤 다시 설정해 주세요.');
    createIfAbsent(frontendFile, `VITE_LOCAL_TOKEN=${backend.fileToken}\n`);
    frontend = readFrontend(root, backend.token);
  }
  if (frontend.mode === 'local' && (backend.mode !== 'local' || !frontend.matches))
    throw new Error(
      '프론트와 백엔드의 로컬 인증 설정이 다릅니다. 두 환경 파일과 실행 환경을 확인해 주세요.',
    );
  if (frontend.mode === 'preview' && !frontend.explicitMode && backend.mode === 'local')
    throw new Error('프론트 로컬 인증 설정이 없습니다. 환경 파일과 실행 환경을 확인해 주세요.');
}
