import { pathFor, readJSON, writeJSON } from './state.mjs';

const count = n => Number.isSafeInteger(n) && n >= 0;
function numericRow(value, required, optional = []) {
  if (!value || !required.every(key => count(value[key]))) return null;
  return Object.fromEntries([...required, ...optional].filter(key => count(value[key])).map(key => [key, value[key]]));
}
const pointRow = value => numericRow(value,
  ['accepted_at', 'turn_to_accepted_ms', 'duration_ms', 'written', 'dropped'], ['input_tokens', 'output_tokens']);
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
  const row = pointRow({ accepted_at, turn_to_accepted_ms: Math.max(0, accepted_at - turn_ended_at),
    duration_ms: usage?.duration_ms, input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens,
    written: count(written) ? written : 0,
    dropped: Object.values(dropped ?? {}).filter(count).reduce((sum, n) => sum + n, 0) });
  if (row) await append('points-stats.json', config.instance_url, row, pointRow, 500);
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarize(rows) {
  const latency = rows.map(row => row.turn_to_accepted_ms / 1000).sort((a, b) => a - b);
  const tokens = key => median(rows.filter(row => count(row[key])).map(row => row[key]));
  return { count: rows.length,
    turn_to_accepted_seconds: { median: median(latency), p90: latency.length ? latency[Math.ceil(latency.length * 0.9) - 1] : null },
    input_tokens_median: tokens('input_tokens'), output_tokens_median: tokens('output_tokens'),
    written_median: median(rows.map(row => row.written)) };
}
export async function pointsStats(config, now = Date.now()) {
  const rows = (await histories('points-stats.json', pointRow, 500))[config.instance_url] ?? [];
  return { last_24h: summarize(rows.filter(row => row.accepted_at >= now - 86400_000 && row.accepted_at <= now)), all: summarize(rows) };
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
