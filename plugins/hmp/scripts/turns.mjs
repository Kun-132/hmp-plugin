import { acquireFileLock, releaseFileLock } from './locks.mjs';
import { lstat } from 'node:fs/promises';
import { loadToken } from './config.mjs';
import { request, serverSummary } from './client.mjs';
import { hash, redact } from './events.mjs';
import { isOffrecord } from './offrecord.mjs';
import { pathFor, readJSON, writeJSON, publishJSON, filesIn, remove } from './state.mjs';

export const AUTOMATED_PREFIXES = Object.freeze(['<task-notification>', '[Subagent hand-back]',
  'Another Claude session sent a message', '<side-sessions-event>', '<ci-monitor-event>', '[SYSTEM NOTIFICATION']);
export const automated = (text, points) => typeof text === 'string' &&
  [...AUTOMATED_PREFIXES, ...(points?.automated_prefixes ?? [])].some(prefix => text.trimStart().startsWith(prefix));
export async function cachedSummary(config, { deadline } = {}) {
  const file = pathFor('server-config.json');
  let cached = await readJSON(file).catch(() => ({}));
  const current = () => cached?.instance_origin && cached.instance_origin !== config.instance_url ? {} : cached ?? {};
  if (!(deadline > Date.now())) return current();
  const modified = (await lstat(file).catch(() => null))?.mtimeMs ?? 0;
  if (cached?.instance_origin === config.instance_url && Date.now() - modified <= 3600_000) return current();
  try {
    const lease = await acquireFileLock(pathFor('server-config-refresh.lock'), {
      stale: owner => Date.now() - Date.parse(owner.started_at) > 10_000,
    });
    if (!lease) return current();
    try {
      const attempts = await readJSON(pathFor('server-config-refresh.json')).catch(() => ({}));
      if (Date.now() - attempts[config.instance_url] < 3600_000 || Date.now() >= deadline) return current();
      // Failed requests must not turn every prompt and Stop into another config fetch.
      await writeJSON(pathFor('server-config-refresh.json'), { ...attempts, [config.instance_url]: Date.now() });
      const token = await loadToken(config);
      const remote = await request(config, token, '/api/client/config', { deadline, timeout: deadline - Date.now() });
      const summary = { ...serverSummary(remote), instance_origin: config.instance_url };
      await writeJSON(file, summary);
      cached = summary;
    } finally { await releaseFileLock(lease); }
  } catch {}
  return current();
}
const sessionName = (config, session) => hash(JSON.stringify([config.instance_url, session])) + '.json';
export const turnName = turn => hash(JSON.stringify([turn.instance_origin, turn.session,
  turn.prompt?.client_event_id, turn.response?.client_event_id])) + '.json';
const part = event => ({ client_event_id: event.client_event_id, text: redact(event.text) });
export async function recordTurn(config, session, event, { prompt = false, complete = false, promptId } = {}) {
  if (typeof session !== 'string' || !session || await isOffrecord(session)) return;
  const file = pathFor('sessions/' + sessionName(config, session));
  const lease = await acquireFileLock(file + '.lock', { wait: 600,
    stale: owner => Date.now() - Date.parse(owner.started_at) > 10_000 });
  if (!lease) throw Error('session_busy');
  try {
    if (await isOffrecord(session)) return;
    const state = await readJSON(file).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
    const prompts = state.prompts ?? (state.prompt ? [state.prompt] : []);
    delete state.prompt;
    delete state.response;
    const closed = state.closed_responses ?? [];
    const matchId = typeof promptId === 'string' && promptId ? hash(promptId) : undefined;
    if (prompt) {
      if (event && !prompts.some(p => p.client_event_id === event.client_event_id))
        prompts.push({ ...part(event), recorded_at: Date.now(), ...(matchId ? { match_id: matchId } : {}) });
    } else {
      const exact = matchId ? prompts.findIndex(p => p.match_id === matchId) : -1;
      const index = exact >= 0 ? exact : prompts.findIndex(p => !matchId || !p.match_id);
      const selected = prompts[index];
      if (!event && !selected) return;
      const identity = hash(JSON.stringify([selected?.client_event_id, event?.client_event_id]));
      if (state.completed_turn === identity || !selected && state.completed_response === event?.client_event_id) return;
      if (complete) {
        const now = Date.now();
        const previous = closed.filter(r => r.recorded_at < (selected?.recorded_at ?? now)).at(-1);
        const turn = { instance_origin: config.instance_url, session, turn_ended_at: now,
          ...(previous ? { previous: part(previous) } : {}), ...(selected ? { prompt: part(selected) } : {}),
          ...(event ? { response: part(event) } : {}) };
        const queued = pathFor('turns/' + turnName(turn));
        try { await publishJSON(queued, turn); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        if (await isOffrecord(session)) await remove(queued);
        state.completed_turn = identity;
        state.completed_response = event?.client_event_id;
        if (event) {
          closed.push({ ...part(event), recorded_at: now, prompt_recorded_at: selected?.recorded_at ?? now });
          closed.sort((a, b) => a.prompt_recorded_at - b.prompt_recorded_at || a.recorded_at - b.recorded_at);
        }
        if (index >= 0) prompts.splice(index, 1);
      }
    }
    const now = Date.now();
    await writeJSON(file, { ...state, closed_responses: closed.slice(-4), prompts: prompts.map(p => ({ ...p, recorded_at: p.recorded_at ?? now }))
      .filter(p => p.recorded_at >= now - 86400_000).slice(-8), instance_origin: config.instance_url, session });
    if (await isOffrecord(session)) await remove(file);
  } finally { await releaseFileLock(lease); }
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
export const retryPath = name => pathFor('turn-retries/' + name);
export async function readyTurns(config) {
  const ready = [];
  for (const entry of await queuedTurns(config)) {
    const retry = await readJSON(retryPath(entry.name)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (Date.now() - entry.turn.turn_ended_at >= 7 * 86400_000 || !(retry?.next_retry_at > Date.now())) ready.push(entry);
  }
  return ready;
}
export async function deferTurn(config, name, code) {
  const retry = await readJSON(retryPath(name)).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
  const attempts = Number.isSafeInteger(retry.attempts) && retry.attempts >= 0 ? retry.attempts + 1 : 1;
  const minutes = [5, 30, 120, 360, 1440][Math.min(attempts - 1, 4)];
  await writeJSON(retryPath(name), { attempts, next_retry_at: Date.now() + minutes * 60_000, code });
  await recordFailure(config, code);
}
export const failurePath = config => pathFor('points-failure-' + hash(config.instance_url) + '.json');
export async function turnStatus(config) {
  const queue = await queuedTurns(config);
  const failure = await readJSON(failurePath(config)).catch(() => null);
  return { count: queue.length, oldest: queue.length ? new Date(queue[0].turn.turn_ended_at).toISOString() : null,
    last_failure: FAILURE_CODES.includes(failure?.code) ? failure.code : null };
}
export const MCP_FAILURE_CODES = Object.freeze(['mcp_config_invalid', 'mcp_version_failed', 'mcp_version_unsupported',
  'mcp_not_connected', 'mcp_tools_missing', 'mcp_tools_unexpected', 'mcp_forbidden_tool', 'mcp_invalid_tool_id', 'mcp_claim_limit', 'mcp_submit_limit',
  'mcp_forbidden_read', 'mcp_verification_tool_call', 'mcp_stream_invalid', 'mcp_timeout', 'mcp_result_failed',
  'mcp_result_missing', 'mcp_exit_failed', 'mcp_spawn_failed', 'mcp_output_limit', 'mcp_interrupted']);
export const FAILURE_CODES = Object.freeze(['stale_lock_cleared', 'events_unavailable', 'capture_pending', 'contract_invalid', 'claude_failed',
  'claude_timeout', 'codex_unavailable', 'codex_failed', 'codex_timeout', 'output_invalid', 'points_unavailable', 'points_rejected', 'daily_limit', 'mcp_failed', 'turn_expired',
  'lines_contract_invalid', 'lines_unavailable', 'lines_rejected', 'lines_model_failed', 'lines_model_timeout',
  'lines_output_invalid', 'lines_daily_limit', ...MCP_FAILURE_CODES]);
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
