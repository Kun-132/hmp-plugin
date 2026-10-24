import { createHash } from 'node:crypto';
import { pathFor, readJSON, writeJSON, filesIn, remove } from './state.mjs';

export function offrecordPath(session) {
  if (typeof session !== 'string' || !session || session.length > 200 || /[\x00-\x1f\x7f]/.test(session)) throw Error('invalid_session');
  const name = encodeURIComponent(session).replaceAll('.', '%2E');
  return pathFor('offrecord/' + name);
}
export async function isOffrecord(session) {
  try { await readJSON(offrecordPath(session)); return true; }
  catch (error) { return error.code !== 'ENOENT' && typeof session === 'string' && !!session; }
}
export async function setOffrecord(session, enabled) {
  const path = offrecordPath(session), before = await isOffrecord(session);
  const id = `${Date.now()}-${process.pid}`, tag = createHash('sha256').update(session).digest('hex');
  await writeJSON(pathFor(`backups/offrecord-${id}.json`), { session_hash: tag, offrecord: before }, true);
  const record = { backup: `backups/offrecord-${id}.json`, diff: { offrecord: { before, after: enabled } },
    restore_args: before ? [session] : [session, '--resume'], verified: false };
  await writeJSON(pathFor(`changes/offrecord-${id}.json`), record, true);
  if (enabled) await writeJSON(path, {}); else await remove(path);
  let discarded = 0;
  if (enabled) for (const name of await filesIn('spool')) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = pathFor(`spool/${name}`);
    let event;
    try { event = await readJSON(file); } catch { continue; }
    if (event.session === session) { await remove(file); discarded++; }
  }
  record.verified = await isOffrecord(session) === enabled;
  await writeJSON(pathFor(`changes/offrecord-${id}.json`), record);
  if (!record.verified) throw Error('verification_failed');
  return { offrecord: enabled, discarded };
}
