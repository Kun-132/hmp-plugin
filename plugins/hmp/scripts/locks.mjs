import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { readJSON, writeJSON, publishJSON, remove } from './state.mjs';

export async function readLock(file) {
  for (let attempt = 0; ; attempt++) {
    try { return await readJSON(file); }
    catch (e) {
      if (e.code === 'ENOENT') return null;
      if (e.message !== 'unsafe_file' || attempt >= 5) throw e;
      // Atomic publication briefly has two links; do not reject another writer's complete lock.
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}
async function withReclaimLock(file, action, wait = 0) {
  const guard = file + '.reclaim', deadline = Date.now() + wait;
  const owner = { token: randomUUID() };
  do {
    try { await writeJSON(guard, owner, true); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const info = await lstat(guard).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (info && Date.now() - info.mtimeMs > 10_000) { await remove(guard); continue; }
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 20));
      continue;
    }
    try { return await action(); }
    finally {
      if ((await readLock(guard))?.token === owner.token) await remove(guard);
    }
  } while (true);
}
export async function reclaimLock(file, stale) {
  return withReclaimLock(file, async () => {
    const current = await readLock(file);
    if (!current || !await stale(current)) return false;
    await remove(file);
    return true;
  });
}
export async function acquireFileLock(file, { stale, wait = 0 } = {}) {
  const deadline = Date.now() + wait;
  const owner = { pid: process.pid, started_at: new Date().toISOString(), token: randomUUID() };
  do {
    try { await publishJSON(file, owner); return { file, owner }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const current = await readLock(file);
    if (current && await stale(current)) await reclaimLock(file, stale);
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (true);
}
export const ownsFileLock = async lease => Boolean(lease && (await readLock(lease.file))?.token === lease.owner.token);
export async function releaseFileLock(lease) {
  if (!lease) return;
  await withReclaimLock(lease.file, async () => {
    if (await ownsFileLock(lease)) await remove(lease.file);
  }, 600);
}
