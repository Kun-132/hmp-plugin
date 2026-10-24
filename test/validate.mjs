import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const binary = process.argv[2];
if (!binary || !binary.startsWith('/')) throw Error('Pass the absolute Claude executable path.');
const home = await mkdtemp(join(tmpdir(), 'hmp-validate-'));
try {
  const bin = join(home, 'mock-bin'); await mkdir(bin);
  await writeFile(join(bin, 'security'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PATH: `${bin}:/usr/bin:/bin`,
    CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_API_KEY: 'synthetic-validation-only',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const target of ['.', 'plugins/hmp']) {
    const result = spawnSync(binary, ['plugin', 'validate', target], { cwd: resolve('.'), env, encoding: 'utf8', timeout: 15000 });
    process.stdout.write(JSON.stringify({ target, exit_code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
      error: result.error?.code ?? null }) + '\n');
    if (result.status !== 0) process.exitCode = 1;
  }
} finally { await rm(home, { recursive: true, force: true }); }
