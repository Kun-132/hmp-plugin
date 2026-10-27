import { hash, redact } from './events.mjs';
import { isOffrecord } from './offrecord.mjs';
import { pathFor, readJSON, writeJSON, publishJSON, filesIn, remove } from './state.mjs';

export const AUTOMATED_PREFIXES = Object.freeze(['<task-notification>', '[Subagent hand-back]',
  'Another Claude session sent a message', '<side-sessions-event>', '<ci-monitor-event>', '[SYSTEM NOTIFICATION']);
export const automated = (text, points) => typeof text === 'string' &&
  [...AUTOMATED_PREFIXES, ...(points?.automated_prefixes ?? [])].some(prefix => text.trimStart().startsWith(prefix));
export async function cachedSummary(config) {
  const cached = await readJSON(pathFor('server-config.json')).catch(() => ({}));
  return cached.instance_origin && cached.instance_origin !== config.instance_url ? {} : cached;
}
const sessionName = (config, session) => hash(JSON.stringify([config.instance_url, session])) + '.json';
export const turnName = turn => hash(JSON.stringify([turn.instance_origin, turn.session,
  turn.prompt?.client_event_id, turn.response?.client_event_id])) + '.json';
const part = event => ({ client_event_id: event.client_event_id, text: redact(event.text) });
export async function recordTurn(config, session, event, { prompt = false, complete = false } = {}) {
  if (typeof session !== 'string' || !session || await isOffrecord(session)) return;
  const file = pathFor('sessions/' + sessionName(config, session));
  const state = await readJSON(file).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
  if (prompt) {
    if (event) state.prompt = part(event);
    else { if (!state.prompt) return; delete state.prompt; }
  } else {
    const identity = event?.client_event_id ?? state.prompt?.client_event_id;
    if (!identity || state.completed_turn === identity) return;
    if (complete) {
      const turn = { instance_origin: config.instance_url, session, turn_ended_at: Date.now(),
        ...(state.response ? { previous: state.response } : {}), ...(state.prompt ? { prompt: state.prompt } : {}), ...(event ? { response: part(event) } : {}) };
      const queued = pathFor('turns/' + turnName(turn));
      try { await publishJSON(queued, turn); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (await isOffrecord(session)) await remove(queued);
      state.completed_turn = identity;
      delete state.prompt;
    }
    if (event) state.response = part(event);
  }
  await writeJSON(file, { ...state, instance_origin: config.instance_url, session });
  if (await isOffrecord(session)) await remove(file);
}
export async function queuedTurns(config) {
  const turns = [];
  for (const name of await filesIn('turns')) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const turn = await readJSON(pathFor('turns/' + name));
      if (turn.instance_origin !== config.instance_url || typeof turn.session !== 'string' || !turn.session ||
          !Number.isFinite(turn.turn_ended_at) || turn.turn_ended_at < 0 || turnName(turn) !== name || !(turn.prompt || turn.response)) continue;
      if (['previous', 'prompt', 'response'].some(key => turn[key] &&
        (!/^hmp_[a-f0-9]{64}$/.test(turn[key].client_event_id) || typeof turn[key].text !== 'string' || Buffer.byteLength(turn[key].text) > 64 * 1024))) continue;
      turns.push({ name, turn });
    } catch { /* A damaged turn cannot hide the rest. */ }
  }
  return turns.sort((a, b) => a.turn.turn_ended_at - b.turn.turn_ended_at || a.name.localeCompare(b.name));
}
export const failurePath = config => pathFor('points-failure-' + hash(config.instance_url) + '.json');
export async function turnStatus(config) {
  const queue = await queuedTurns(config);
  const failure = await readJSON(failurePath(config)).catch(() => null);
  return { count: queue.length, oldest: queue.length ? new Date(queue[0].turn.turn_ended_at).toISOString() : null,
    last_failure: FAILURE_CODES.includes(failure?.code) ? failure.code : null };
}
export const FAILURE_CODES = Object.freeze(['stale_lock_cleared', 'events_unavailable', 'capture_pending', 'contract_invalid', 'claude_failed',
  'claude_timeout', 'output_invalid', 'points_unavailable', 'points_rejected', 'daily_limit', 'mcp_failed']);
export async function recordFailure(config, code) {
  if (!FAILURE_CODES.includes(code)) throw Error('invalid_failure');
  await writeJSON(failurePath(config), { code, at: Date.now() });
}
export function sentencesFor(turn) {
  const sentences = [];
  for (const part of ['previous', 'prompt', 'response']) {
    const text = turn[part]?.text;
    if (!text) continue;
    let start = 0;
    const emit = end => {
      if (end > start && text.slice(start, end).trim()) sentences.push({ n: sentences.length + 1, part, text: text.slice(start, end) });
      start = end;
    };
    for (let i = 0; i < text.length;) {
      const ch = String.fromCodePoint(text.codePointAt(i)); i += ch.length;
      if (/[。！？!?\n]/u.test(ch) || ch === '.' && (i === text.length || /\s/u.test(text[i])) || i - start >= 900) emit(i);
    }
    emit(text.length);
  }
  return sentences;
}
