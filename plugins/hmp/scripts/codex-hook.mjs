import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { spawn } from 'node:child_process';

async function checked(path, directory = false) {
  const rel = relative(homedir(), path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw Error('outside_home');
  let current = homedir();
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i < parts.length - 1 || directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw Error('unsafe_path');
  }
  return path;
}

async function main() {
  const event = process.argv[2];
  if (!['UserPromptSubmit', 'Stop', 'SessionStart'].includes(event)) return;
  const registry = await checked(join(homedir(), '.claude/plugins/installed_plugins.json'));
  const file = await open(registry, constants.O_RDONLY | constants.O_NOFOLLOW);
  let installed;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) return;
    installed = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  const entries = installed?.plugins?.['hmp@hmp-marketplace'];
  if (!Array.isArray(entries)) return;
  const cache = await checked(join(homedir(), '.claude/plugins/cache/hmp-marketplace'), true);
  for (const entry of entries) {
    if (typeof entry?.installPath !== 'string' || !isAbsolute(entry.installPath)) continue;
    const rel = relative(cache, entry.installPath);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) continue;
    let hook;
    try { hook = await checked(join(entry.installPath, 'scripts/hook.mjs')); } catch { continue; }
    await new Promise(resolve => {
      const child = spawn(process.execPath, [hook, event, 'codex'], { stdio: ['inherit', 'ignore', 'ignore'] });
      child.on('error', resolve); child.on('close', resolve);
    });
    return;
  }
}
// Missing or unsafe installations must never interrupt Codex.
main().catch(() => {}).finally(() => { process.exitCode = 0; });
