import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const original = cp.execFile, run = promisify(original);
const wrapped = (...args) => original(...args);
// Host startup delays for the fake executable must not stand in for keychain lookup latency.
wrapped[promisify.custom] = async (binary, args, options) => {
  if (binary !== 'security') return run(binary, args, options);
  const missing = () => Object.assign(Error('synthetic_keychain_missing'), { code: 1 });
  if (args[0] !== 'find-generic-password' || args[args.indexOf('-s') + 1] !== 'hmp-client') throw missing();
  const entries = JSON.parse(await readFile(join(process.env.HOME, 'mock-keychain.json'), 'utf8'));
  const account = args[args.indexOf('-a') + 1];
  if (!Object.hasOwn(entries, account)) throw missing();
  return { stdout: entries[account], stderr: '' };
};
cp.execFile = wrapped;
syncBuiltinESMExports();
