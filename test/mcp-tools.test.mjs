import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { runMcpClaude } from '../plugins/hmp/scripts/mcp-tools.mjs';
import { claudeArgs, POINT_TOOLS, LINE_TOOLS, EXTRACTION_TOOLS } from '../plugins/hmp/scripts/worker.mjs';

const privateText = 'SYNTHETIC_PRIVATE_BODY_ID_SECRET';
const known = [...POINT_TOOLS, ...LINE_TOOLS, ...EXTRACTION_TOOLS, 'mcp__hmp__status'];
const added = 'mcp__hmp__new_tool';
const usage = { input_tokens: 6, cache_creation_input_tokens: 7949, cache_read_input_tokens: 7742, output_tokens: 1610 };
function fake({ extra = [], ignore = false, fail = false, invalidUsage = false } = {}) {
  return `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOME + '/launches.jsonl', JSON.stringify(args) + '\\n');
const start = args.indexOf('--disallowedTools');
const end = args.findIndex((arg, i) => i > start && arg.startsWith('--'));
const denied = start < 0 ? [] : args.slice(start + 1, end < 0 ? undefined : end);
const tools = ${JSON.stringify([...known, ...extra, 'Read', 'mcp__other__tool'])}.filter(name => ${ignore} || !denied.includes(name));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: '${privateText}',
  mcp_servers: [{ name: 'hmp', status: 'connected' }], tools }) + '\\n');
setTimeout(() => {
  fs.appendFileSync(process.env.HOME + '/model-calls.jsonl', JSON.stringify(args) + '\\n');
  const claim = args[args.indexOf('--allowedTools') + 1];
  const name = claim === '${POINT_TOOLS[0]}' ? '${POINT_TOOLS[1]}' : '${LINE_TOOLS[1]}';
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: '${privateText}', name, input: { text: '${privateText}' } }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: '${fail ? 'error_during_execution' : 'success'}', is_error: ${fail},
    usage: ${JSON.stringify(invalidUsage ? { input_tokens: -1, cache_creation_input_tokens: 1.5, cache_read_input_tokens: privateText, output_tokens: usage.output_tokens } : usage)}, result: '${privateText}' }) + '\\n');
}, 150);
`;
}
const log = async (f, name = 'launches') => (await readFile(join(f.home, name + '.jsonl'), 'utf8').catch(e => {
  if (e.code === 'ENOENT') return ''; throw e;
})).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const values = (args, flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const end = args.findIndex((arg, j) => j > i && arg.startsWith('--'));
  return args.slice(i + 1, end < 0 ? undefined : end);
};
async function local(t, options = {}) {
  const f = await fixture(t, { claude: fake(options) });
  const previous = process.env.HOME;
  process.env.HOME = f.home;
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  return f;
}
const run = (f, stage = POINT_TOOLS) => runMcpClaude({ instance_url: f.url }, f.project, stage, 2000, { binary: join(f.bin, 'claude') });

test('first MCP launch harvests only names at init, kills before model, then launches the filtered stage', async t => {
  const f = await local(t);
  await f.write('mcp-tools.json', { 'https://other.example': ['mcp__hmp__other_origin'] });
  const result = await run(f);
  assert.equal(result.status, 'ok'); assert.equal(result.submits, 1);
  assert.deepEqual({ ...result.usage, duration_ms: 0 }, { ...usage, input_total_tokens: 15697, duration_ms: 0 });
  assert.ok(result.usage.duration_ms >= 0);
  const calls = await log(f);
  assert.equal(calls.length, 2); assert.equal((await log(f, 'model-calls')).length, 1);
  assert.equal(calls[0][calls[0].indexOf('--max-turns') + 1], '0');
  assert.deepEqual(values(calls[0], '--disallowedTools'), []);
  assert.deepEqual(values(calls[1], '--disallowedTools'), known.filter(name => !POINT_TOOLS.includes(name)).sort());
  assert.deepEqual(values(calls[1], '--allowedTools'), POINT_TOOLS);
  assert.ok(!calls[1].includes('mcp__hmp__other_origin'));
  const saved = await f.read('mcp-tools.json');
  assert.deepEqual(saved[f.url], [...known].sort());
  assert.deepEqual(saved['https://other.example'], ['mcp__hmp__other_origin']);
  assert.equal((await stat(join(f.home, '.hmp/mcp-tools.json'))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(saved).includes(privateText));
  assert.ok(!JSON.stringify(result).includes(privateText));
  assert.equal((await run(f, LINE_TOOLS)).status, 'ok');
  const next = (await log(f)).at(-1);
  assert.equal((await log(f)).length, 3);
  assert.deepEqual(values(next, '--disallowedTools'), known.filter(name => !LINE_TOOLS.includes(name)).sort());
  assert.deepEqual(values(next, '--allowedTools'), LINE_TOOLS);
});
test('a new HMP tool kills at init, adds only its name and retries once without calling the first model', async t => {
  const f = await local(t, { extra: [added] });
  await f.write('mcp-tools.json', { [f.url]: known });
  assert.equal((await run(f)).status, 'ok');
  const calls = await log(f);
  assert.equal(calls.length, 2); assert.equal((await log(f, 'model-calls')).length, 1);
  assert.ok(!values(calls[0], '--disallowedTools').includes(added));
  assert.ok(values(calls[1], '--disallowedTools').includes(added));
  assert.deepEqual((await f.read('mcp-tools.json'))[f.url], [...known, added].sort());
  for (const args of calls) for (const name of POINT_TOOLS) assert.ok(!values(args, '--disallowedTools').includes(name));
});
test('persistently visible extra tools fail after one retry, with no model or stats and a fixed status code', async t => {
  const f = await fixture(t, { claude: fake({ extra: [added], ignore: true }),
    remote: { points: { backlog: 1 } } });
  await f.write('server-config.json', { instance_origin: f.url, points: { limits: { max_turns_per_run: 1 } } });
  await f.write('mcp-tools.json', { [f.url]: known });
  const response = await f.run('worker.mjs');
  assert.equal(response.code, 0, response.stderr);
  assert.equal((await log(f)).length, 2); assert.equal((await log(f, 'model-calls')).length, 0);
  assert.equal((await f.read('points-usage.json')).turns, 1);
  assert.equal((await f.names('.')).includes('points-stats.json'), false);
  const status = JSON.parse((await f.run('manage.mjs', ['status'])).stdout);
  assert.equal(status.turns.last_failure, 'mcp_tools_unexpected');
  assert.ok(!JSON.stringify(status).includes(privateText));
});
test('successful point and line MCP stages record only numeric usage under path mcp; failures record none', async t => {
  for (const failed of [false, true]) {
    const f = await fixture(t, { claude: fake({ fail: failed }), remote: { points: { backlog: 1 }, pending: { lines: 1 } } });
    await f.write('server-config.json', { instance_origin: f.url, points: { limits: { max_turns_per_run: 2 } } });
    const response = await f.run('worker.mjs');
    assert.equal(response.code, 0, response.stderr);
    assert.equal((await log(f)).length, 3);
    assert.equal((await log(f, 'model-calls')).length, 2);
    if (failed) {
      assert.equal((await f.names('.')).includes('points-stats.json'), false);
      continue;
    }
    const file = join(f.home, '.hmp/points-stats.json');
    const saved = await readFile(file, 'utf8'), rows = JSON.parse(saved)[f.url];
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['path', 'engine', 'at', 'duration_ms', ...Object.keys(usage), 'input_total_tokens'].sort());
      assert.equal(row.path, 'mcp'); assert.equal(row.engine, 'claude');
      assert.ok(Object.entries(row).every(([key, value]) => key === 'path' || key === 'engine' || Number.isSafeInteger(value) && value >= 0));
      assert.deepEqual({ ...row, path: undefined, engine: undefined, at: undefined, duration_ms: undefined },
        { ...usage, input_total_tokens: 15697, path: undefined, engine: undefined, at: undefined, duration_ms: undefined });
    }
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!saved.includes(privateText));
    const status = JSON.parse((await f.run('manage.mjs', ['status'])).stdout);
    assert.equal(status.points_stats.all.count, 0); assert.equal(status.points_stats.mcp.all.count, 2);
    assert.equal(status.points_stats.mcp.all.input_total_tokens_median, 15697);
  }
});
test('MCP usage rejects malformed counts without persisting result contents', async t => {
  const f = await local(t, { invalidUsage: true });
  await f.write('mcp-tools.json', { [f.url]: known });
  const result = await run(f);
  assert.equal(result.status, 'ok');
  assert.deepEqual(Object.keys(result.usage).sort(), ['duration_ms', 'output_tokens']);
  assert.ok(!JSON.stringify(result).includes(privateText));
});
test('stage tools cannot be disallowed and legacy CLI arguments stay unchanged even with a catalog supplied', () => {
  const directory = '/tmp/synthetic';
  for (const stage of [POINT_TOOLS, LINE_TOOLS]) {
    const args = claudeArgs(directory, { claimTool: stage[0], mcpOnly: true, disallowedTools: known });
    assert.deepEqual(values(args, '--allowedTools'), stage);
    for (const name of stage) assert.ok(!values(args, '--disallowedTools').includes(name));
  }
  for (const stage of [EXTRACTION_TOOLS, LINE_TOOLS]) {
    const options = { claimTool: stage[0], mcpOnly: false };
    assert.deepEqual(claudeArgs(directory, { ...options, disallowedTools: known }), claudeArgs(directory, options));
  }
});
