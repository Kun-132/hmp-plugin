import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mcpEvents, withTestEnv } from './helpers.mjs';
import { mcpCodexArgs, runMcpCodex } from '../plugins/hmp/scripts/mcp-tools.mjs';
import { pointsCodexArgs } from '../plugins/hmp/scripts/points-worker.mjs';
import { claudeArgs, runClaude, VERIFY_PROMPT, POINT_TOOLS, LINE_TOOLS } from '../plugins/hmp/scripts/worker.mjs';
import { MCP_FAILURE_CODES } from '../plugins/hmp/scripts/turns.mjs';

const privateText = 'SYNTHETIC_PRIVATE_MODEL_OUTPUT';
const counts = { input_tokens: 302, cached_input_tokens: 300, output_tokens: 45 };
const call = (tool, id = tool, server = 'hmp', type = 'item.completed') => ({ type,
  item: { type: 'mcp_tool_call', id, server, tool: tool.replace(/^mcp__hmp__/, ''), arguments: { text: privateText } } });
const done = { type: 'turn.completed', usage: counts };
const success = stage => [call(stage[0]), call(stage[1]), done];
const emit = events => `process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n'))});`;
const fake = events => `const fs = require('node:fs');
fs.appendFileSync(process.env.HOME + '/codex-launches.jsonl', JSON.stringify({ args: process.argv.slice(2),
  cwd: process.cwd(), env: process.env, mode: fs.statSync('.').mode & 511, mask: process.umask() }) + '\\n');
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
  fs.writeFileSync(process.env.HOME + '/codex-input', input);
  fs.mkdirSync('logs'); fs.writeFileSync('logs/transient', 'synthetic');
  fs.mkdirSync('state'); fs.writeFileSync('state/transient', 'synthetic');
  ${emit(events)}
});`;
async function binary(f, body) {
  const executable = join(f.bin, 'codex');
  await writeFile(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) {
require('node:fs').appendFileSync(process.env.HOME + '/codex-versions', 'v'); process.stdout.write('synthetic codex'); process.exit(0); }
${body}`, { mode: 0o700 });
  return executable;
}
async function direct(f, body, { stage = POINT_TOOLS, timeout = 2000, executable, verify = false } = {}) {
  const path = executable ?? await binary(f, body);
  return withTestEnv({ ...f.env, USER: 'synthetic', LOGNAME: 'synthetic', CODEX_HOME: join(f.home, '.codex'),
    OPENAI_API_KEY: 'SYNTHETIC_FORBIDDEN', HMP_EXTRACTOR_TOKEN: 'SYNTHETIC_FORBIDDEN' },
    () => runMcpCodex({ instance_url: f.url }, stage, timeout, { binary: path, tempRoot: f.home, verify }));
}
async function cleaned(f) {
  assert.deepEqual((await readdir(f.home)).filter(name => name.startsWith('hmp-mcp-codex-')), []);
}
const launches = async f => (await readFile(join(f.home, 'codex-launches.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const ok = r => { assert.equal(r.code, 0, r.stderr); assert.equal(r.stderr, ''); };

test('MCP Codex args mirror the per-turn boundary, with only the stage tools and required HMP URL', async t => {
  const f = await fixture(t);
  await withTestEnv(f.env, () => {
    const directory = '/tmp/synthetic directory', config = { instance_url: 'https://synthetic.example' };
    for (const stage of [POINT_TOOLS, LINE_TOOLS]) {
      const expected = pointsCodexArgs(directory);
      expected.splice(expected.indexOf('--output-last-message'), 4);
      expected.splice(expected.indexOf('mcp_servers={}'), 1,
        'mcp_servers.hmp.url="https://synthetic.example/mcp"', '-c',
        `mcp_servers.hmp.enabled_tools=${JSON.stringify(stage.map(tool => tool.replace(/^mcp__hmp__/, '')))}`,
        '-c', 'mcp_servers.hmp.required=true');
      const args = mcpCodexArgs(config, stage, directory);
      assert.deepEqual(args, expected);
      assert.ok(args.includes('tool_output_token_limit=100000'));
    }
  });
});

test('both MCP stages accept one claim and submit, deduplicate event phases, parse usage and clean private state', async t => {
  const f = await fixture(t);
  for (const stage of [POINT_TOOLS, LINE_TOOLS]) {
    const events = [
      { type: 'item.started', item: { type: 'reasoning', text: privateText } },
      { type: 'item.completed', item: { type: 'error', message: privateText } },
      ...['item.started', 'item.updated', 'item.completed'].map(type => call(stage[0], 'claim', 'hmp', type)),
      ...['item.started', 'item.updated', 'item.completed'].map(type => call(stage[1], 'submit', 'hmp', type)),
      { type: 'item.completed', item: { type: 'agent_message', text: privateText } }, done,
    ];
    const result = await direct(f, fake(events), { stage });
    assert.equal(result.status, 'ok'); assert.equal(result.lines, false); assert.equal(result.submits, 1);
    assert.deepEqual({ ...result.usage, duration_ms: 0 }, { input_total_tokens: 302, input_tokens: 2,
      cache_read_input_tokens: 300, output_tokens: 45, duration_ms: 0 });
    assert.ok(result.usage.duration_ms >= 0); assert.ok(!JSON.stringify(result).includes(privateText));
    const launch = (await launches(f)).at(-1);
    await withTestEnv(f.env, () => assert.deepEqual(launch.args, mcpCodexArgs({ instance_url: f.url }, stage, launch.cwd)));
    const state = await stat(join(f.home, '.hmp', 'codex-state'));
    assert.ok(state.isDirectory()); assert.equal(state.mode & 0o777, 0o700);
    assert.equal(launch.mode, 0o700); assert.equal(launch.mask, 0o077); assert.equal(launch.env.TMPDIR, launch.cwd);
    assert.ok(!JSON.stringify(launch.env).includes('SYNTHETIC_FORBIDDEN'));
    assert.equal(launch.env.CODEX_HOME, join(f.home, '.codex'));
    await assert.rejects(stat(launch.cwd), { code: 'ENOENT' }); await cleaned(f);
  }
});

test('MCP Codex stdin is the Claude system prompt followed by exactly the same claim instructions', async t => {
  const f = await fixture(t, { claude: `let input = ''; process.stdin.on('data', c => input += c);
process.stdin.on('end', () => { require('node:fs').writeFileSync(process.env.HOME + '/claude-input', input); });` });
  for (const stage of [POINT_TOOLS, LINE_TOOLS]) {
    await direct(f, fake(success(stage)), { stage });
    await withTestEnv(f.env, () => runClaude(f.project, stage[0], 2000, { binary: join(f.bin, 'claude'), mcpOnly: true }));
    const args = claudeArgs(f.project, { claimTool: stage[0], mcpOnly: true });
    assert.equal(await readFile(join(f.home, 'codex-input'), 'utf8'),
      args[args.indexOf('--system-prompt') + 1] + '\n' + await readFile(join(f.home, 'claude-input'), 'utf8'));
  }
});

test('Codex verify uses the stage args with all four tools, the exact no-tool prompt and no Claude configuration', async t => {
  const f = await fixture(t, { remote: { points: {} }, claude: 'process.exit(1);' });
  await f.write('config.json', { ...await f.read('config.json'), engine: 'codex' });
  await rm(join(f.home, '.hmp/mcp.json'));
  await binary(f, fake([
    { type: 'thread.started', thread_id: 'synthetic' }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'reasoning', text: privateText } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }, done,
  ]));
  const result = await f.run('manage.mjs', ['verify']); ok(result);
  assert.deepEqual(JSON.parse(result.stdout).worker,
    { ready: true, mcp: true, lines: true, server: 'hmp', url: f.url + '/mcp' });
  const [launch] = await launches(f);
  await withTestEnv(f.env, () => assert.deepEqual(launch.args,
    mcpCodexArgs({ instance_url: f.url }, [...POINT_TOOLS, ...LINE_TOOLS], launch.cwd)));
  assert.equal((await launches(f)).length, 1);
  assert.equal(await readFile(join(f.home, 'codex-input'), 'utf8'), VERIFY_PROMPT);
  await assert.rejects(stat(launch.cwd), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.home, '.hmp/points-stats.json')), { code: 'ENOENT' });
});

test('Codex verify never reports MCP or lines ready on initialization, turn, stream, exit or spawn failures', async t => {
  const f = await fixture(t, { remote: { points: {} } });
  await f.write('config.json', { ...await f.read('config.json'), engine: 'codex' });
  for (const body of [
    `process.stderr.write('required MCP servers failed to initialize: hmp: AuthRequired'); process.exit(1);`,
    emit([{ type: 'turn.started' }]), emit([done]) + 'process.exit(1);',
    emit([{ type: 'turn.failed' }]), emit([{ type: 'error', message: privateText }]),
    "process.stdout.write('not JSON');", emit([call(POINT_TOOLS[0]), done]),
    emit([{ type: 'item.started', item: { type: 'command_execution' } }, done]),
  ]) {
    await binary(f, body);
    const result = await f.run('manage.mjs', ['verify']); ok(result);
    assert.deepEqual(JSON.parse(result.stdout).worker,
      { ready: false, mcp: false, lines: false, server: 'hmp', url: f.url + '/mcp' });
    assert.ok(!result.stdout.includes(privateText));
  }
  await rm(join(f.bin, 'codex'));
  const result = await f.run('manage.mjs', ['verify']); ok(result);
  assert.equal(JSON.parse(result.stdout).worker.mcp, false);
  assert.equal(JSON.parse(result.stdout).worker.lines, false);
});

test('Codex verify rejects every tool item at every event phase as verification_tool_call', async t => {
  const f = await fixture(t);
  for (const type of ['mcp_tool_call', 'command_execution', 'file_change', 'web_search', 'collab_tool_call', 'todo_list', 'unknown']) {
    for (const phase of ['item.started', 'item.updated', 'item.completed']) {
      const result = await direct(f, fake([{ type: phase, item: { type } }, done]), { verify: true });
      assert.equal(result.status, 'failed'); assert.equal(result.reason, 'verification_tool_call');
      assert.equal(result.lines, false); assert.equal(result.submits, 0); await cleaned(f);
    }
  }
});

for (const type of ['command_execution', 'file_change', 'web_search', 'collab_tool_call', 'todo_list', 'unknown']) {
  test(`MCP Codex stops forbidden item type ${type} at item.started`, async t => {
    const f = await fixture(t);
    const result = await direct(f, fake([{ type: 'item.started', item: { type } }, ...success(POINT_TOOLS)]));
    assert.equal(result.reason, 'forbidden_tool'); assert.equal(result.status, 'failed');
    assert.equal(result.submits, 0); await cleaned(f);
  });
}

test('MCP Codex rejects other servers, other-stage tools, repeated claims and excess submits', async t => {
  const f = await fixture(t);
  for (const stage of [POINT_TOOLS, LINE_TOOLS]) {
    for (const [reason, events] of [
      ['forbidden_tool', [call(stage[0], 'other', 'other')]],
      ['forbidden_tool', [call(stage === POINT_TOOLS ? LINE_TOOLS[0] : POINT_TOOLS[0])]],
      ['claim_limit', [call(stage[0], 'claim-1'), call(stage[0], 'claim-2')]],
      ['submit_limit', [call(stage[0]), ...Array.from({ length: 4 }, (_, i) => call(stage[1], 'submit-' + i))]],
      ['invalid_tool_id', [call(stage[0], 'same'), call(stage[1], 'same')]],
      ['invalid_tool_id', [call(stage[0], '')]],
    ]) {
      const result = await direct(f, fake([...events, done]), { stage });
      assert.equal(result.status, 'failed'); assert.equal(result.reason, reason);
      assert.ok(MCP_FAILURE_CODES.includes('mcp_' + reason)); await cleaned(f);
    }
  }
});

test('MCP Codex fails with existing fixed codes for unavailable tools, failed turns, malformed output, exit and spawn', async t => {
  const f = await fixture(t);
  for (const [reason, body] of [
    ['tools_missing', fake([done])], ['result_missing', fake([call(POINT_TOOLS[0])])],
    ['result_failed', fake([{ type: 'turn.failed', error: { message: privateText } }])],
    ['result_failed', fake([{ type: 'error', message: privateText }])],
    ['stream_invalid', "process.stdout.write('not JSON');"],
    ['exit_failed', 'process.exit(1);'],
    ['output_limit', "process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1));"],
  ]) {
    const result = await direct(f, body);
    assert.equal(result.reason, reason); assert.equal(result.status, reason === 'tools_missing' ? 'stage_unavailable' : 'failed');
    assert.ok(MCP_FAILURE_CODES.includes('mcp_' + reason)); assert.ok(!JSON.stringify(result).includes(privateText));
    await cleaned(f);
  }
  const mask = process.umask();
  assert.equal((await direct(f, '', { executable: join(f.bin, 'missing') })).reason, 'spawn_failed');
  assert.equal(process.umask(), mask); await cleaned(f);
});

test('MCP Codex timeout kills the process group and removes temporary state', async t => {
  const f = await fixture(t), tick = join(f.home, 'ticks'), pidFile = join(f.home, 'descendant-pid');
  t.after(async () => {
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  const body = `const fs = require('node:fs'); const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(tick)}, '.'), 10);`)}], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
  assert.equal((await direct(f, body, { timeout: 1000 })).reason, 'timeout');
  const before = await readFile(tick, 'utf8'); assert.ok(before.length > 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await readFile(tick, 'utf8'), before); await cleaned(f);
});

test('worker uses Codex for both MCP stages without Claude or mcp.json and persists the engine', async t => {
  const f = await fixture(t, { remote: { points: { backlog: 1 }, pending: { lines: 1 } } });
  await f.write('config.json', { ...await f.read('config.json'), engine: 'codex' });
  await f.write('server-config.json', { instance_origin: f.url, points: { limits: { max_turns_per_run: 2 } } });
  await rm(join(f.home, '.hmp/mcp.json'));
  await writeFile(join(f.bin, 'claude'), '#!/bin/sh\nexit 1\n');
  const script = fake(success(POINT_TOOLS));
  await binary(f, script.replace(emit(success(POINT_TOOLS)), `const args = process.argv.slice(2);
const stage = args.some(a => a.includes('enabled_tools=') && a.includes('claim_turn'))
  ? ${JSON.stringify(POINT_TOOLS)} : ${JSON.stringify(LINE_TOOLS)};
for (const tool of stage) process.stdout.write(JSON.stringify({ type: 'item.completed', item: {
  id: tool, type: 'mcp_tool_call', server: 'hmp', tool: tool.replace('mcp__hmp__', '') } }) + '\\n');
${emit([done])}`));
  const capture = join(f.home, 'capture-spawn.mjs');
  await writeFile(capture, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; import { writeFileSync } from 'node:fs';
const original = cp.spawn; cp.spawn = (file, args, options) => {
if (file === 'codex' && args.includes('exec')) writeFileSync(process.env.HOME + '/spawn-env.json', JSON.stringify(options.env));
return original(file, args, options); }; syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS += ' --import=' + capture;
  ok(await f.run('worker.mjs'));
  assert.equal((await launches(f)).length, 2);
  assert.equal(await readFile(join(f.home, 'codex-versions'), 'utf8'), 'v');
  const env = JSON.parse(await readFile(join(f.home, 'spawn-env.json'), 'utf8'));
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'TMPDIR']);
  const rows = (await f.read('points-stats.json'))[f.url]; assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.path === 'mcp' && row.engine === 'codex'));
  const status = JSON.parse((await f.run('manage.mjs', ['status'])).stdout);
  assert.equal(status.points_stats.mcp.by_engine.codex.all.count, 2);
  assert.equal(status.points_stats.mcp.by_engine.claude.all.count, 0);
  for (const launch of await launches(f)) await assert.rejects(stat(launch.cwd), { code: 'ENOENT' });
});

for (const engine of [undefined, 'claude']) {
  test(`worker keeps Claude MCP for engine ${engine ?? 'default'}`, async t => {
    const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'hmp', status: 'connected' }], tools: [...POINT_TOOLS] };
    const f = await fixture(t, { remote: { points: { backlog: 1 } }, claude: `require('node:fs').appendFileSync(process.env.HOME + '/claude-runs', 'c');
${mcpEvents([init, { type: 'assistant', message: { content: [{ type: 'tool_use', name: POINT_TOOLS[1], id: 'submit' }] } },
      { type: 'result', subtype: 'success', is_error: false, usage: {} }])}` });
    if (engine) await f.write('config.json', { ...await f.read('config.json'), engine });
    await f.write('mcp-tools.json', { [f.url]: POINT_TOOLS });
    await f.write('server-config.json', { instance_origin: f.url, points: { limits: { max_turns_per_run: 1 } } });
    await binary(f, 'process.exit(1);');
    ok(await f.run('worker.mjs'));
    assert.equal(await readFile(join(f.home, 'claude-runs'), 'utf8'), 'c');
    await assert.rejects(stat(join(f.home, 'codex-versions')), { code: 'ENOENT' });
    assert.equal((await f.read('points-stats.json'))[f.url][0].engine, 'claude');
  });
}

test('Codex version failure uses mcp_version_failed without launching either stage', async t => {
  for (const body of ['process.exit(1);', 'setInterval(() => {}, 1000);']) {
    const f = await fixture(t, { remote: { points: { backlog: 1 } } });
    await f.write('config.json', { ...await f.read('config.json'), engine: 'codex' });
    await f.write('server-config.json', { instance_origin: f.url, points: {} });
    await writeFile(join(f.bin, 'codex'), `#!${process.execPath}\n${body}`, { mode: 0o700 });
    ok(await f.run('worker.mjs'));
    const status = JSON.parse((await f.run('manage.mjs', ['status'])).stdout);
    assert.equal(status.turns.last_failure, 'mcp_version_failed');
    assert.equal((await f.names('.')).includes('points-usage.json'), false);
  }
});
