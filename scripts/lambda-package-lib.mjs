import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const markerName = '.ecolephant-lambda-build';
const markerValue = 'ecolephant-lambda-v1\n';

function requireOwnedDirectory(target, parent, prefix, requireMarker = false) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe package directory');
  const resolved = fs.realpathSync(target);
  if (
    path.dirname(resolved) !== fs.realpathSync(parent) ||
    !path.basename(resolved).startsWith(prefix)
  ) {
    throw new Error('Package directory is outside the intended build folder');
  }
  if (requireMarker) {
    const marker = path.join(resolved, markerName);
    if (
      !fs.existsSync(marker) ||
      !fs.lstatSync(marker).isFile() ||
      fs.readFileSync(marker, 'utf8') !== markerValue
    ) {
      throw new Error('Existing package folder is not owned by the build script');
    }
  }
  return resolved;
}

function sourceFilter(source) {
  const name = path.basename(source);
  if (name.startsWith('.') || name === '__pycache__') return false;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) return false;
  return stat.isDirectory() || (stat.isFile() && ['.py', '.json'].includes(path.extname(name)));
}

export function buildLambda(repository, installDependencies) {
  const repo = fs.realpathSync(repository);
  const build = path.join(repo, '.build');
  fs.mkdirSync(build, { recursive: true });
  if (fs.lstatSync(build).isSymbolicLink() || fs.realpathSync(build) !== build) {
    throw new Error('Unsafe build directory');
  }
  const target = path.join(build, 'lambda');
  if (fs.existsSync(target)) requireOwnedDirectory(target, build, 'lambda', true);
  const moduleRoot = path.join(repo, 'backend', 'ecolephant');
  const handler = path.join(repo, 'backend', 'lambda_handler.py');
  if (
    !fs.lstatSync(moduleRoot).isDirectory() ||
    fs.lstatSync(moduleRoot).isSymbolicLink() ||
    !fs.lstatSync(handler).isFile() ||
    fs.lstatSync(handler).isSymbolicLink()
  ) {
    throw new Error('Invalid backend sources');
  }
  const stage = fs.mkdtempSync(path.join(build, '.lambda-stage-'));
  let backup = null;
  try {
    installDependencies(stage);
    fs.cpSync(moduleRoot, path.join(stage, 'ecolephant'), {
      recursive: true,
      filter: sourceFilter,
    });
    fs.copyFileSync(handler, path.join(stage, 'lambda_handler.py'));
    fs.writeFileSync(path.join(stage, markerName), markerValue);
    if (fs.existsSync(target)) {
      requireOwnedDirectory(target, build, 'lambda', true);
      backup = path.join(build, `.lambda-backup-${randomUUID()}`);
      fs.renameSync(target, backup);
    }
    try {
      fs.renameSync(stage, target);
    } catch (error) {
      if (backup) fs.renameSync(backup, target);
      backup = null;
      throw error;
    }
    if (backup) {
      const safeBackup = requireOwnedDirectory(backup, build, '.lambda-backup-', true);
      fs.rmSync(safeBackup, { recursive: true });
      backup = null;
    }
    return target;
  } finally {
    if (fs.existsSync(stage)) {
      const safeStage = requireOwnedDirectory(stage, build, '.lambda-stage-');
      fs.rmSync(safeStage, { recursive: true });
    }
  }
}
