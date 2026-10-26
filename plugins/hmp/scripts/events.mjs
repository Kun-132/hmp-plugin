import { isOffrecord } from './offrecord.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CLIENT_VERSION } from './config.mjs';
import { pathFor, readJSON, writeJSON, publishJSON, filesIn, remove } from './state.mjs';
import { request } from './client.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function redact(text) {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, '<PRIVATE_KEY>')
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=：]\s*[^\r\n]+/gi, '<HEADER_SECRET>')
    .replace(/(?<![\w.-])["']?[\w.-]{0,64}(?:api[_-]?key|token|secret|passw(?:or)?d|passwd|authorization|cookie|credential)[\w.-]{0,64}["']?\s*[:=：]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)/gi, '<SECRET>')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '<AUTH>')
    .replace(/\b(?:oc_sk_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+|AKIA[0-9A-Z]{16})\b/gi, '<TOKEN>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<JWT>')
    .replace(/(?:パスワード|トークン)\s*[:：=]\s*[^\s、。]+/g, '<SECRET>');
}
export function makeEvent(input, kind) {
  const raw = kind === 'prompt' ? input.prompt : input.last_assistant_message;
  if (typeof raw !== 'string' || !raw.trim() || typeof input.session_id !== 'string' || !input.session_id) return null;
  const text = redact(raw);
  if (Buffer.byteLength(text) > 64 * 1024) throw Error('event_limit');
  const turn = typeof input.prompt_id === 'string' && input.prompt_id ? hash(input.prompt_id) : hash(text);
  const session = input.session_id;
  return { client_event_id: `hmp_${hash(JSON.stringify([hash(session), turn, kind]))}`, kind, session, turn,
    occurred_at: new Date(input.occurred_at ?? Date.now()).toISOString(), text };
}
export const spoolFilename = event => hash(JSON.stringify([event.instance_origin, event.client_event_id])) + '.json';
export async function enqueue(value, config) {
  const event = { ...value, instance_origin: config.instance_url };
  if (await isOffrecord(event.session)) return;
  try { await readJSON(join(pathFor('sent'), spoolFilename(event))); return; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await publishJSON(join(pathFor('spool'), spoolFilename(event)), event); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (await isOffrecord(event.session)) await remove(join(pathFor('spool'), spoolFilename(event)));
}
export async function spoolStatus(config) {
  let spool = 0, spool_held = 0;
  for (const name of await filesIn('spool')) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    spool++;
    const entry = await readJSON(join(pathFor('spool'), name)).catch(() => null);
    if (entry?.instance_origin !== config.instance_url) spool_held++;
  }
  return { spool, spool_held };
}
export async function flush(config, token, { deadline = Date.now() + 2400, max = 200 } = {}) {
  if (!token) return;
  const pending = [];
  for (const name of await filesIn('spool')) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const event = await readJSON(join(pathFor('spool'), name));
      const keys = ['client_event_id', 'kind', 'session', 'turn', 'occurred_at', 'text', 'instance_origin'];
      if (!event || Object.keys(event).some(key => !keys.includes(key)) ||
          event.instance_origin !== config.instance_url || spoolFilename(event) !== name || !['prompt', 'response'].includes(event.kind) || typeof event.text !== 'string' ||
          typeof event.session !== 'string' || !event.session || !/^[a-f0-9]{64}$/.test(event.turn) ||
          event.client_event_id !== `hmp_${hash(JSON.stringify([hash(event.session), event.turn, event.kind]))}` ||
          typeof event.occurred_at !== 'string' || new Date(event.occurred_at).toISOString() !== event.occurred_at ||
          Buffer.byteLength(event.text) > 64 * 1024) continue;
      if (await isOffrecord(event.session)) { await remove(join(pathFor('spool'), name)); continue; }
      event.text = redact(event.text);
      pending.push({ name, event });
    } catch { /* One damaged entry must not hide the rest. */ }
  }
  pending.sort((a, b) => a.event.occurred_at.localeCompare(b.event.occurred_at)
    || a.event.session.localeCompare(b.event.session) || a.event.turn.localeCompare(b.event.turn)
    || (a.event.kind === b.event.kind ? 0 : a.event.kind === 'prompt' ? -1 : 1) || a.name.localeCompare(b.name));
  for (let i = 0; i < Math.min(max, pending.length) && Date.now() < deadline; i += 20) {
    const batch = [];
    for (const item of pending.slice(i, Math.min(i + 20, max))) {
      if (await isOffrecord(item.event.session)) await remove(join(pathFor('spool'), item.name));
      else batch.push(item);
    }
    if (!batch.length) continue;
    const receipt = await request(config, token, '/api/client/events', {
      body: { client_version: CLIENT_VERSION, device: config.device, events: batch.map(({ event: { instance_origin, ...event } }) => event) }, deadline, timeout: deadline - Date.now(),
    });
    // Partial/ambiguous acknowledgements stay on disk; server idempotency makes replay safe.
    if (!Array.isArray(receipt.rejected) || receipt.rejected.length || !Number.isSafeInteger(receipt.accepted) ||
        !Number.isSafeInteger(receipt.duplicates) || receipt.accepted < 0 || receipt.duplicates < 0 ||
        receipt.accepted + receipt.duplicates !== batch.length) return;
    for (const { name } of batch) {
      await writeJSON(join(pathFor('sent'), name), { sent_at: new Date().toISOString() });
      await remove(join(pathFor('spool'), name));
    }
    await writeJSON(pathFor('last-send.json'), { sent_at: new Date().toISOString() });
  }
}
