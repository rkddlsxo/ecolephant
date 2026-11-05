// Prepares self-hosted MediaPipe Pose assets in frontend/public/mediapipe (git-ignored).
// - Copies the WASM runtime from the installed @mediapipe/tasks-vision package.
// - Downloads pose_landmarker_lite.task once (skip with --skip-model, refresh with --force).
// The browser then loads everything from the app's own origin, not from a CDN.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'frontend/public/mediapipe');
const argv = process.argv.slice(2);
const args = new Set(argv);
// --model lite|full|heavy|all (default lite). full/heavy are for accuracy comparison.
const modelArg = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'lite';
const variants = modelArg === 'all' ? ['lite', 'full', 'heavy'] : [modelArg];
if (!variants.every((name) => ['lite', 'full', 'heavy'].includes(name))) {
  console.error(`Unknown --model ${modelArg}. Use lite, full, heavy or all.`);
  process.exit(1);
}

const require = createRequire(path.join(root, 'frontend/package.json'));
// package.json is not in the package's "exports", so resolve the CJS entry and use its folder.
const packageDir = path.dirname(require.resolve('@mediapipe/tasks-vision'));
const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

fs.rmSync(path.join(target, 'wasm'), { recursive: true, force: true });
fs.mkdirSync(path.join(target, 'wasm'), { recursive: true });
// FilesetResolver.forVisionTasks(base) picks the SIMD or no-SIMD build; the "module" variant is
// only used with useModule=true, so it is not shipped.
for (const file of fs
  .readdirSync(path.join(packageDir, 'wasm'))
  .filter((name) => !name.includes('_module_')))
  fs.copyFileSync(path.join(packageDir, 'wasm', file), path.join(target, 'wasm', file));
fs.writeFileSync(path.join(target, 'VERSION'), `@mediapipe/tasks-vision ${version}\n`);
console.log(`Copied MediaPipe WASM ${version} to ${path.relative(root, target)}/wasm`);

if (args.has('--skip-model')) process.exit(0);
let failed = false;
for (const variant of variants) {
  const name = `pose_landmarker_${variant}.task`;
  const modelFile = path.join(target, name);
  const modelUrl = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${variant}/float16/1/${name}`;
  if (fs.existsSync(modelFile) && !args.has('--force')) {
    console.log(`Model already present: ${path.relative(root, modelFile)}`);
    continue;
  }
  const response = await fetch(modelUrl).catch((error) => ({
    ok: false,
    status: error.cause?.code ?? error.message,
  }));
  if (!response.ok) {
    console.error(`Model download failed (${response.status}). Download manually:\n  ${modelUrl}`);
    console.error(`and save it as ${path.relative(root, modelFile)}`);
    failed = true;
    continue;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(`${modelFile}.tmp`, bytes);
  fs.renameSync(`${modelFile}.tmp`, modelFile);
  console.log(
    `Downloaded ${path.relative(root, modelFile)} (${(bytes.length / 1e6).toFixed(1)} MB)`,
  );
}
if (failed) process.exit(1);
