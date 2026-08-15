#!/usr/bin/env node
/**
 * One-command setup for the CORVVS engine.
 *
 * Everything lands in `engine/.venv` — including Python itself, which `uv` fetches as a
 * standalone build. No system Python is used or required, nothing touches global pip,
 * nothing is added to PATH. Uninstalling is deleting that folder.
 *
 * The one genuinely machine-specific decision is which PyTorch to install: NVIDIA on
 * Windows needs a CUDA-matched wheel from PyTorch's own index, while Apple Silicon gets
 * MPS support from the stock PyPI build. Getting this wrong is the single most common way
 * to end up silently running on the CPU at ~170x slower, so this script picks
 * deliberately and then *verifies* rather than assuming.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine');
const VENV = path.join(ENGINE, '.venv');
const PYTHON_VERSION = '3.12';

const venvPython = () => process.platform === 'win32'
  ? path.join(VENV, 'Scripts', 'python.exe')
  : path.join(VENV, 'bin', 'python');

function say(msg) { console.log(`\x1b[36m[setup]\x1b[0m ${msg}`); }
function warn(msg) { console.log(`\x1b[33m[setup]\x1b[0m ${msg}`); }
function fail(msg) { console.error(`\x1b[31m[setup]\x1b[0m ${msg}`); process.exit(1); }

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if (result.error || result.status !== 0) {
    fail(`\`${cmd} ${args.join(' ')}\` failed${result.error ? `: ${result.error.message}` : ''}`);
  }
}

function capture(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return result.status === 0 ? result.stdout.trim() : null;
}

// -- 0. uv ------------------------------------------------------------------------

if (!capture('uv', ['--version'])) {
  fail(
    'uv is not installed. It is the only prerequisite (it supplies Python itself).\n' +
    '  Windows:  powershell -c "irm https://astral.sh/uv/install.ps1 | iex"\n' +
    '  macOS:    curl -LsSf https://astral.sh/uv/install.sh | sh\n' +
    '  Then re-run: npm run setup'
  );
}

// -- 1. decide which PyTorch this machine needs -----------------------------------

function chooseTorch() {
  if (process.platform === 'darwin') {
    // Apple Silicon MPS support is in the stock PyPI wheel — there is no special index,
    // and picking one would be wrong. Intel Macs have no GPU backend and land on CPU.
    const arm = process.arch === 'arm64';
    return {
      index: null,
      expect: arm ? 'mps' : 'cpu',
      note: arm
        ? 'Apple Silicon — stock PyTorch wheel (MPS support included)'
        : 'Intel Mac — no GPU backend available, this will run on the CPU',
    };
  }

  if (process.platform === 'win32') {
    const smi = capture('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
    if (smi) {
      return {
        index: 'https://download.pytorch.org/whl/cu128',
        expect: 'cuda',
        note: `NVIDIA GPU detected (${smi.split('\n')[0]}) — CUDA 12.8 wheel`,
      };
    }
    return {
      index: 'https://download.pytorch.org/whl/cpu',
      expect: 'cpu',
      note: 'No NVIDIA GPU found — installing the CPU build, which will be very slow',
    };
  }

  fail(`${process.platform} is not supported yet — only Windows and macOS.`);
}

const torch = chooseTorch();
say(torch.note);

// -- 2. private Python ------------------------------------------------------------

if (existsSync(venvPython())) {
  say('reusing the existing engine/.venv');
} else {
  say(`creating engine/.venv with a private Python ${PYTHON_VERSION} (uv will fetch it)`);
  run('uv', ['venv', VENV, '--python', PYTHON_VERSION]);
}

// -- 3. PyTorch, then everything else ---------------------------------------------

say('installing PyTorch — this is the big one, expect a few minutes');
run('uv', [
  'pip', 'install', '--python', venvPython(), 'torch',
  ...(torch.index ? ['--index-url', torch.index] : []),
]);

say('installing Kokoro and audio dependencies');
run('uv', ['pip', 'install', '--python', venvPython(), '-r', path.join(ENGINE, 'requirements.txt')]);

// -- 4. verify the GPU is actually reachable --------------------------------------

// The whole point of the engine. An install that "succeeded" onto the CPU is a failed
// install with a cheerful exit code, so check before declaring victory.
say('verifying GPU access');
const probe = capture(venvPython(), ['-c',
  'import torch;' +
  "print('cuda' if torch.cuda.is_available() else ('mps' if torch.backends.mps.is_available() else 'cpu'))",
]);

if (!probe) fail('could not run the installed Python — the venv looks broken, delete engine/.venv and retry');

console.log();
if (probe === torch.expect && probe !== 'cpu') {
  say(`\x1b[32m✓ ready — inference will run on ${probe}\x1b[0m`);
  say('start it with: npm start');
} else if (probe === 'cpu' && torch.expect === 'cpu') {
  warn('✓ installed, but running on the CPU as expected for this machine (~29s/sentence).');
  warn('  The client\'s built-in fallback is just as fast, so the engine buys you little here.');
} else {
  warn(`✗ expected ${torch.expect} but PyTorch reports ${probe}.`);
  warn('  The engine will work but be ~170x slower than it should be.');
  warn('  See engine/README.md — usually a CUDA version mismatch with your driver.');
  process.exitCode = 1;
}
