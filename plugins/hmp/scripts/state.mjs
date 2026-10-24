import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink, link } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve, sep, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export const root = () => join(homedir(), '.hmp');
export const pathFor = name => join(root(), name);
export async function privateDir(path = root()) {
  if (path !== root()) await privateDir(dirname(path));
  try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw Error('unsafe_directory');
  await chmod(path, 0o700);
}
export async function readText(path, max = 1024 * 1024) {
  // Never follow a redirected .hmp directory or final file.
  if (path.startsWith(root() + sep)) {
    for (let p = dirname(path); p !== dirname(root()); p = dirname(p)) {
      const info = await lstat(p);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('unsafe_directory');
    }
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > max) throw Error('unsafe_file');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
export const readJSON = async path => JSON.parse(await readText(path));
export async function writeJSON(path, data, exclusive = false) {
  await privateDir(dirname(path));
  const text = JSON.stringify(data) + '\n';
  if (exclusive) {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    return;
  }
  const info = await lstat(path).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw Error('unsafe_file');
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeJSON(tmp, data, true);
  await rename(tmp, path);
}
export async function publishJSON(path, data) {
  await privateDir(dirname(path));
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeJSON(tmp, data, true);
  // Publish a fully synced file without overwriting a concurrently queued event.
  try { await link(tmp, path); } finally { await unlink(tmp); }
}
export async function filesIn(name) {
  const dir = pathFor(name);
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('unsafe_directory');
    return await readdir(dir);
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export async function suppressed(cwd) {
  // A malformed pause is fail-closed, including an unreadable file.
  try {
    const pause = await readJSON(pathFor('pause'));
    if (!Number.isFinite(Date.parse(pause.until)) || Date.parse(pause.until) > Date.now()) return true;
  } catch (e) { if (e.code !== 'ENOENT') return true; }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return true;
  // Check both lexical and canonical parents so symlinked projects retain exclusion.
  const { realpath } = await import('node:fs/promises');
  for (let p of new Set([resolve(cwd), await realpath(cwd)])) {
    for (;;) {
      try { await lstat(join(p, '.hmp-ignore')); return true; }
      catch (e) { if (e.code !== 'ENOENT') return true; }
      const parent = dirname(p);
      if (parent === p) break;
      p = parent;
    }
  }
  return false;
}
export const remove = async path => { try { await unlink(path); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
