import { pathFor, readJSON, writeJSON } from './state.mjs';

const count = n => Number.isSafeInteger(n) && n >= 0;
function numericRow(value, required, optional = []) {
  if (!value || !required.every(key => count(value[key]))) return null;
  return Object.fromEntries([...required, ...optional].filter(key => count(value[key])).map(key => [key, value[key]]));
}
const tokenFields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'input_total_tokens', 'output_tokens'];
function reasonCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([code, n]) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(code)
    && code.length <= 64 && count(n)));
}
function pointRow(value) {
  if (value?.path === 'mcp') {
    const row = numericRow(value, ['at', 'duration_ms'], tokenFields);
    return row ? { path: 'mcp', ...row } : null;
  }
  const row = numericRow(value, ['accepted_at', 'turn_to_accepted_ms', 'duration_ms', 'written', 'dropped'], tokenFields);
  if (value && Object.hasOwn(value, 'engine')) {
    if (!['claude', 'codex'].includes(value.engine)) return null;
    if (row) row.engine = value.engine;
  }
  if (row && value.dropped_by_reason) row.dropped_by_reason = reasonCounts(value.dropped_by_reason);
  return row;
}
const backlogRow = value => numericRow(value, ['at', 'extraction', 'backlog']);
async function histories(file, clean, limit) {
  const value = await readJSON(pathFor(file)).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
  return Object.fromEntries(Object.entries(value).filter(([, rows]) => Array.isArray(rows))
    .map(([origin, rows]) => [origin, rows.map(clean).filter(Boolean).slice(-limit)]));
}
async function append(file, origin, row, clean, limit) {
  const values = await histories(file, clean, limit);
  values[origin] = [...(values[origin] ?? []), row].slice(-limit);
  await writeJSON(pathFor(file), values);
}
export async function recordPointsStats(config, { accepted_at, turn_ended_at, usage, written, dropped }) {
  const row = pointRow({ engine: config.engine ?? 'claude', accepted_at, turn_to_accepted_ms: Math.max(0, accepted_at - turn_ended_at),
    duration_ms: usage?.duration_ms, ...Object.fromEntries(tokenFields.map(key => [key, usage?.[key]])),
    written: count(written) ? written : 0,
    dropped: Object.values(dropped ?? {}).filter(count).reduce((sum, n) => sum + n, 0),
    dropped_by_reason: reasonCounts(dropped) });
  if (row) await append('points-stats.json', config.instance_url, row, pointRow, 500);
}
export async function recordMcpStats(config, usage, at = Date.now()) {
  const row = pointRow({ path: 'mcp', at, duration_ms: usage?.duration_ms,
    ...Object.fromEntries(tokenFields.map(key => [key, usage?.[key]])) });
  if (row) await append('points-stats.json', config.instance_url, row, pointRow, 500);
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function usageSummary(rows) {
  const tokens = key => median(rows.filter(row => count(row[key])).map(row => row[key]));
  return { count: rows.length, duration_ms_median: tokens('duration_ms'),
    ...Object.fromEntries(tokenFields.map(key => [key + '_median', tokens(key)])) };
}
function summarize(rows) {
  const latency = rows.map(row => row.turn_to_accepted_ms / 1000).sort((a, b) => a - b);
  return { ...usageSummary(rows),
    turn_to_accepted_seconds: { median: median(latency), p90: latency.length ? latency[Math.ceil(latency.length * 0.9) - 1] : null },
    written_median: median(rows.map(row => row.written)),
    dropped: rows.reduce((sum, row) => sum + row.dropped, 0),
    dropped_by_reason: reasonCounts(rows.reduce((totals, row) => {
      for (const [code, n] of Object.entries(row.dropped_by_reason ?? {})) totals[code] = (totals[code] ?? 0) + n;
      return totals;
    }, Object.create(null))) };
}
export async function pointsStats(config, now = Date.now()) {
  const rows = (await histories('points-stats.json', pointRow, 500))[config.instance_url] ?? [];
  const terminal = rows.filter(row => row.path !== 'mcp'), mcp = rows.filter(row => row.path === 'mcp');
  const summary = values => ({ last_24h: summarize(values.filter(row => row.accepted_at >= now - 86400_000 && row.accepted_at <= now)), all: summarize(values) });
  return { ...summary(terminal),
    by_engine: Object.fromEntries(['claude', 'codex'].map(engine => [engine, summary(terminal.filter(row => (row.engine ?? 'claude') === engine))])),
    mcp: { last_24h: usageSummary(mcp.filter(row => row.at >= now - 86400_000 && row.at <= now)), all: usageSummary(mcp) } };
}
export async function recordBacklog(config, summary, at = Date.now()) {
  await append('backlog-history.json', config.instance_url,
    { at, extraction: summary.pending.extraction, backlog: summary.points?.backlog ?? 0 }, backlogRow, 200);
}
export async function backlogHistory(config) {
  const rows = (await histories('backlog-history.json', backlogRow, 200))[config.instance_url] ?? [];
  const display = row => row ? { ...row, at: new Date(row.at).toISOString() } : null;
  return { first: display(rows[0]), latest: display(rows.at(-1)) };
}
