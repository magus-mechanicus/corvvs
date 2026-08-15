#!/usr/bin/env node
/**
 * Starts the engine using the private Python in engine/.venv.
 *
 * Exists mostly to paper over the venv layout difference between platforms
 * (Windows `Scripts/python.exe` vs. `bin/python` everywhere else) so that `npm start`
 * is the same command on every machine. Runs with cwd=engine/ so server.py's sibling
 * imports resolve.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine');
const python = process.platform === 'win32'
  ? path.join(ENGINE, '.venv', 'Scripts', 'python.exe')
  : path.join(ENGINE, '.venv', 'bin', 'python');

if (!existsSync(python)) {
  console.error(
    `\x1b[31m[corvvs]\x1b[0m The engine isn't set up yet — ${path.relative(ROOT, python)} is missing.\n` +
    `        Run: npm run setup`
  );
  process.exit(1);
}

const server = spawn(python, [path.join(ENGINE, 'server.py')], {
  cwd: ENGINE,
  stdio: 'inherit',
});

// Forward Ctrl-C so the model unloads cleanly rather than being orphaned.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}

server.on('exit', (code) => process.exit(code ?? 0));
