import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { writeJSON, pathFor } from '../plugins/hmp/scripts/state.mjs';
import { recordPointsStats, recordMcpStats, pointsStats, recordBacklog, backlogHistory } from '../plugins/hmp/scripts/points-stats.mjs';

const config = { instance_url: 'https://synthetic.example' };
const other = { instance_url: 'https://other.example' };
const row = (accepted_at, seconds = 1) => ({ accepted_at, turn_to_accepted_ms: seconds * 1000,
  duration_ms: 200, written: 2, dropped: 0 });
async function localHome(t) {
  const previous = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'hmp-stats-'));
  process.env.HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
}
test('points stats append numeric fields only, privately, and retain 500 per origin', async t => {
  await localHome(t);
  await writeJSON(pathFor('points-stats.json'), {
    [config.instance_url]: Array.from({ length: 500 }, (_, i) => row(i)), [other.instance_url]: [row(5)],
  });
  for (const accepted_at of [10000, 20000]) await recordPointsStats(config, {
    accepted_at, turn_ended_at: accepted_at - 500, written: 3,
    dropped: { evidence_not_found: 4, speaker_mismatch: 2, text: 'SYNTHETIC_PRIVATE',
      nested: { text: 'SYNTHETIC_PRIVATE' }, 'SYNTHETIC_PRIVATE body': 1, negative: -1, fractional: 1.5 },
    usage: { duration_ms: 123, input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 200,
      input_total_tokens: 302, output_tokens: 50, text: 'SYNTHETIC_PRIVATE' },
    text: 'SYNTHETIC_PRIVATE', id: 'SYNTHETIC_ID', session: 'SYNTHETIC_SESSION',
  });
  const file = pathFor('points-stats.json'), raw = await readFile(file, 'utf8'), saved = JSON.parse(raw);
  const rows = saved[config.instance_url];
  assert.equal(rows.length, 500); assert.equal(rows[0].accepted_at, 2);
  assert.deepEqual(rows.at(-1), { accepted_at: 20000, turn_to_accepted_ms: 500, duration_ms: 123,
    written: 3, dropped: 7, dropped_by_reason: { evidence_not_found: 4, speaker_mismatch: 2 },
    input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, input_total_tokens: 302, output_tokens: 50 });
  assert.deepEqual(saved[other.instance_url], [row(5)]);
  assert.ok(rows.every(value => Object.entries(value).every(([key, n]) => key === 'dropped_by_reason'
    ? Object.values(n).every(Number.isSafeInteger) : typeof n === 'number')));
  assert.ok(!raw.includes('SYNTHETIC_'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test('points stats calculate numeric medians and nearest-rank p90 for 24h and all retained rows', async t => {
  await localHome(t);
  const now = 2 * 86400_000;
  const rows = Array.from({ length: 10 }, (_, i) => ({ ...row(now - i, 10 - i), written: i }));
  rows[0].input_tokens = 10; rows[1].input_tokens = 100; rows[2].input_tokens = 20;
  rows[0].output_tokens = 0; rows[1].output_tokens = 10;
  rows[0].input_total_tokens = 302; rows[1].input_total_tokens = 1000;
  rows[0].dropped = 6; rows[0].dropped_by_reason = { evidence_not_found: 4, speaker_mismatch: 2 };
  rows[1].dropped = 1; rows[1].dropped_by_reason = { speaker_mismatch: 1 };
  rows.push({ ...row(now - 86400_000, 11), written: 10 },
    { ...row(now - 86400_001, 12), dropped: 3, dropped_by_reason: { evidence_not_found: 3 } });
  await writeJSON(pathFor('points-stats.json'), { [config.instance_url]: rows, [other.instance_url]: [row(now, 99)] });
  const stats = await pointsStats(config, now);
  assert.equal(stats.last_24h.count, 11); assert.equal(stats.all.count, 12);
  assert.deepEqual(stats.last_24h.turn_to_accepted_seconds, { median: 6, p90: 10 });
  assert.deepEqual(stats.all.turn_to_accepted_seconds, { median: 6.5, p90: 11 });
  assert.equal(stats.all.input_tokens_median, 20); assert.equal(stats.all.output_tokens_median, 5);
  assert.equal(stats.all.input_total_tokens_median, 651);
  assert.equal(stats.last_24h.dropped, 7); assert.equal(stats.all.dropped, 10);
  assert.deepEqual(stats.last_24h.dropped_by_reason, { evidence_not_found: 4, speaker_mismatch: 3 });
  assert.deepEqual(stats.all.dropped_by_reason, { evidence_not_found: 7, speaker_mismatch: 3 });
  assert.equal(stats.last_24h.written_median, 5);
  const empty = await pointsStats({ instance_url: 'https://empty.example' }, now);
  assert.deepEqual(empty.last_24h, { count: 0, turn_to_accepted_seconds: { median: null, p90: null },
    duration_ms_median: null, input_tokens_median: null, cache_creation_input_tokens_median: null, cache_read_input_tokens_median: null,
    input_total_tokens_median: null, output_tokens_median: null, written_median: null,
    dropped: 0, dropped_by_reason: {} });
});
test('backlog keeps 200 numeric observations per origin and displays first/latest timestamps', async t => {
  await localHome(t);
  const rows = Array.from({ length: 200 }, (_, at) => ({ at, extraction: 1000 - at, backlog: 500 - at }));
  await writeJSON(pathFor('backlog-history.json'), { [config.instance_url]: rows, [other.instance_url]: [rows[0]] });
  await recordBacklog(config, { pending: { extraction: 1, lines: 100, text: 'SYNTHETIC_PRIVATE' },
    points: { backlog: 2, instructions: 'SYNTHETIC_PRIVATE' } }, 1000);
  const file = pathFor('backlog-history.json'), raw = await readFile(file, 'utf8'), saved = JSON.parse(raw);
  assert.equal(saved[config.instance_url].length, 200);
  assert.deepEqual(saved[other.instance_url], [rows[0]]);
  assert.deepEqual(await backlogHistory(config), {
    first: { ...rows[1], at: new Date(1).toISOString() }, latest: { at: new Date(1000).toISOString(), extraction: 1, backlog: 2 },
  });
  assert.ok(saved[config.instance_url].every(value => Object.values(value).every(n => typeof n === 'number')));
  assert.ok(!raw.includes('SYNTHETIC_PRIVATE')); assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test('MCP numeric rows keep terminal medians separate and use completion time for the 24h window', async t => {
  await localHome(t);
  const now = 3 * 86400_000;
  const terminal = { ...row(now), input_total_tokens: 302, input_tokens: 2 };
  const oldMcp = { path: 'mcp', at: now - 86400_001, duration_ms: 50000,
    input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 9800, input_total_tokens: 10000, output_tokens: 5000 };
  await writeJSON(pathFor('points-stats.json'), { [config.instance_url]: [terminal, oldMcp], [other.instance_url]: [oldMcp] });
  await recordMcpStats(config, { duration_ms: 17600, input_tokens: 6, cache_creation_input_tokens: 7949,
    cache_read_input_tokens: 7742, input_total_tokens: 15697, output_tokens: 1610,
    result: 'SYNTHETIC_PRIVATE', id: 'SYNTHETIC_ID', session: 'SYNTHETIC_SESSION' }, now);
  await recordMcpStats(config, { duration_ms: 1000, input_tokens: 10, cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000, input_total_tokens: 1110, output_tokens: 10 }, now - 86400_000);
  const file = pathFor('points-stats.json'), raw = await readFile(file, 'utf8'), saved = JSON.parse(raw);
  assert.deepEqual(saved[config.instance_url][0], terminal);
  assert.deepEqual(saved[other.instance_url], [oldMcp]);
  assert.ok(saved[config.instance_url].slice(1).every(row => row.path === 'mcp'
    && Object.entries(row).every(([key, n]) => key === 'path' || typeof n === 'number')));
  assert.ok(!raw.includes('SYNTHETIC_')); assert.equal((await stat(file)).mode & 0o777, 0o600);
  const stats = await pointsStats(config, now);
  assert.equal(stats.all.count, 1); assert.equal(stats.all.input_total_tokens_median, 302);
  assert.equal(stats.mcp.all.count, 3); assert.equal(stats.mcp.last_24h.count, 2);
  assert.equal(stats.mcp.all.input_tokens_median, 10); assert.equal(stats.mcp.all.input_total_tokens_median, 10000);
  assert.deepEqual(stats.mcp.last_24h, { count: 2, duration_ms_median: 9300, input_tokens_median: 8,
    cache_creation_input_tokens_median: 4024.5, cache_read_input_tokens_median: 4371,
    input_total_tokens_median: 8403.5, output_tokens_median: 810 });
});
test('status samples fresh config only, shows current-origin stats and retains history when offline', async t => {
  const f = await fixture(t, { remote: { pending: { extraction: 8 }, points: { backlog: 5, instructions: 'SYNTHETIC_PRIVATE' } } });
  await f.write('points-stats.json', { [f.url]: [{ ...row(Date.now(), 2), input_tokens: 2, input_total_tokens: 302,
    dropped: 6, dropped_by_reason: { evidence_not_found: 4, speaker_mismatch: 2 } },
  { path: 'mcp', at: Date.now(), duration_ms: 17600, input_tokens: 6, cache_creation_input_tokens: 7949,
    cache_read_input_tokens: 7742, input_total_tokens: 15697, output_tokens: 1610 }], [other.instance_url]: [row(Date.now(), 99)] });
  const status = async () => {
    const result = await f.run('manage.mjs', ['status']);
    assert.equal(result.code, 0, result.stderr); assert.ok(!result.stdout.includes('SYNTHETIC_PRIVATE'));
    return JSON.parse(result.stdout);
  };
  const first = await status();
  assert.equal(first.points_stats.all.count, 1); assert.equal(first.points_stats.all.turn_to_accepted_seconds.median, 2);
  assert.equal(first.points_stats.all.input_tokens_median, 2);
  assert.equal(first.points_stats.all.input_total_tokens_median, 302);
  assert.equal(first.points_stats.mcp.all.count, 1);
  assert.equal(first.points_stats.mcp.last_24h.input_total_tokens_median, 15697);
  assert.equal(first.points_stats.mcp.all.duration_ms_median, 17600);
  assert.equal(first.points_stats.last_24h.dropped, 6);
  assert.deepEqual(first.points_stats.last_24h.dropped_by_reason, { evidence_not_found: 4, speaker_mismatch: 2 });
  assert.deepEqual(first.backlog_history.first, first.backlog_history.latest);
  assert.equal(first.backlog_history.latest.extraction, 8); assert.equal(first.backlog_history.latest.backlog, 5);
  assert.ok(Number.isFinite(Date.parse(first.backlog_history.latest.at)));
  f.state.remote.pending.extraction = 3; f.state.remote.points.backlog = 1;
  const second = await status();
  assert.deepEqual(second.backlog_history.first, first.backlog_history.first);
  assert.equal(second.backlog_history.latest.extraction, 3); assert.equal(second.backlog_history.latest.backlog, 1);
  f.state.fail = true;
  const offline = await status();
  assert.equal(offline.pending, null); assert.deepEqual(offline.backlog_history, second.backlog_history);
  assert.equal((await f.read('backlog-history.json'))[f.url].length, 2);
});
