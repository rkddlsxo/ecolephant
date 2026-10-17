import { root, venvPython, requireSetup, run } from './runtime.mjs';
requireSetup();
run(venvPython, ['backend/run.py'], root);
