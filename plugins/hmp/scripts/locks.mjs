import { randomUUID } from 'node:crypto';
import { rename, link } from 'node:fs/promises';
import { readJSON, publishJSON, remove } from './state.mjs';

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
export async function reclaimLock(file, owner) {
  const moved = file + '.' + randomUUID() + '.stale';
  try { await rename(file, moved); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  const actual = await readLock(moved);
  if (JSON.stringify(actual) !== JSON.stringify(owner)) {
    // A replacement owner must never be unlinked at the shared lock path.
    try { await link(moved, file); await remove(moved); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return false;
  }
  await remove(moved);
  return true;
}
export async function acquireFileLock(file, { stale, wait = 0 } = {}) {
  const deadline = Date.now() + wait;
  const owner = { pid: process.pid, started_at: new Date().toISOString(), token: randomUUID() };
  do {
    try { await publishJSON(file, owner); return { file, owner }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const current = await readLock(file);
    if (current && await stale(current)) await reclaimLock(file, current);
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (true);
}
export const ownsFileLock = async lease => Boolean(lease && (await readLock(lease.file))?.token === lease.owner.token);
export async function releaseFileLock(lease) {
  if (await ownsFileLock(lease)) await reclaimLock(lease.file, lease.owner);
}
