import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, mcpEvents } from './helpers.mjs';
import { validateConfig } from '../plugins/hmp/scripts/config.mjs';
import { pointsCodexArgs, runPointsCodex, runPointsClaude } from '../plugins/hmp/scripts/points-worker.mjs';
import { POINT_TOOLS, LINE_TOOLS } from '../plugins/hmp/scripts/worker.mjs';

const point = { kind: 'decision', speaker: 'user', text: '合成の判断', evidence: [1] };
const schema = { type: 'object', additionalProperties: false, required: ['points'], properties: {
  points: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false,
    required: ['kind', 'speaker', 'text', 'evidence'], properties: {
      kind: { type: 'string', enum: ['decision'] }, speaker: { type: 'string', enum: ['user', 'assistant', 'third_party'] },
      text: { type: 'string', minLength: 1, maxLength: 300 },
      evidence: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'integer', minimum: 1 } },
    } } },
} };
const contract = { contract_version: 'hmp-points-v1', instructions: '合成の抽出手順。', output_schema: schema };
const output = { points: [point] };
const counts = { input_tokens: 302, cached_input_tokens: 300, output_tokens: 45 };
const privateText = 'SYNTHETIC_PRIVATE_JSONL_BODY';
const ok = r => { assert.equal(r.code, 0, r.stderr); assert.equal(r.stderr, ''); return r.stdout ? JSON.parse(r.stdout) : null; };
const fake = `const fs = require('node:fs');
fs.appendFileSync(process.env.HOME + '/codex-launches.jsonl', JSON.stringify({ args: process.argv.slice(2), env: process.env,
  cwd: process.cwd(), mode: fs.statSync(process.cwd()).mode & 511, mask: process.umask(),
  schema: JSON.parse(fs.readFileSync('output-schema.json')), schemaMode: fs.statSync('output-schema.json').mode & 511,
  outMode: fs.statSync('out.json').mode & 511 }) + '\\n');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);
process.stdin.on('end', () => { fs.writeFileSync(process.env.HOME + '/codex-input', input);
  fs.mkdirSync('logs'); fs.writeFileSync('logs/transient', 'synthetic');
  fs.mkdirSync('state'); fs.writeFileSync('state/transient', 'synthetic');
  fs.writeFileSync('out.json', ${JSON.stringify(JSON.stringify(output))});
  const events = JSON.stringify({ type: 'item.completed', item: { text: ${JSON.stringify(privateText)}, usage: ${JSON.stringify(counts)} } }) + '\\n'
    + JSON.stringify({ type: 'turn.completed', usage: ${JSON.stringify(counts)} });
  process.stdout.write(events.slice(0, 23)); process.stdout.write(events.slice(23));
});`;
async function binary(f, body = fake) {
  const path = join(f.bin, 'codex');
  await writeFile(path, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.HOME + '/codex-directories.jsonl', JSON.stringify(process.cwd()) + '\\n');\n${body}`, { mode: 0o700 });
  return path;
}
async function launches(f) {
  return (await readFile(join(f.home, 'codex-launches.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
}
async function cached(f, limits = {}) {
  await f.write('server-config.json', { instance_origin: f.url, points: { ...contract, limits }, pending: {} });
}
async function seed(t) {
  const f = await fixture(t, { claude: 'process.exit(1);' });
  await binary(f); ok(await f.run('manage.mjs', ['engine', 'codex'])); await cached(f);
  await f.write('worker.lock', { pid: process.pid });
  ok(await f.hook('UserPromptSubmit', { prompt: '合成の判断。次へ!', prompt_id: 'turn-1' }));
  ok(await f.hook('Stop', { last_assistant_message: '合成の回答。', prompt_id: 'turn-1' }));
  await rm(join(f.home, '.hmp/worker.lock'));
  return f;
}
async function direct(f, body = fake, timeout = 1000) {
  const executable = await binary(f, body), previous = process.env;
  process.env = { ...f.env, USER: 'synthetic', LOGNAME: 'synthetic', CODEX_HOME: join(f.home, '.codex') };
  try { return await runPointsCodex(contract, [{ n: 1, part: 'prompt', text: '合成。' }], timeout, { binary: executable, tempRoot: f.home }); }
  finally { process.env = previous; }
}
async function cleaned(f) {
  for (const launch of await launches(f)) await assert.rejects(stat(launch.cwd), { code: 'ENOENT' });
  const directories = (await readFile(join(f.home, 'codex-directories.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  for (const directory of directories) await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.home)).filter(n => n.startsWith('hmp-points-codex-')), []);
}

test('engine is a fixed optional enum; changes record backup, diff, restore and readback, and setup preserves it', async t => {
  const f = await fixture(t), before = await f.read('config.json');
  assert.deepEqual(validateConfig(before), before);
  for (const engine of ['claude', 'codex']) assert.equal(validateConfig({ ...before, engine }).engine, engine);
  for (const engine of ['other', '', null, false, 0, [], {}, undefined]) {
    assert.throws(() => validateConfig({ ...before, engine }), /invalid_engine/);
  }
  for (const args of [[], ['other'], ['codex', 'claude']]) {
    assert.equal((await f.run('manage.mjs', ['engine', ...args])).code, 1);
    assert.deepEqual(await f.read('config.json'), before);
  }
  assert.deepEqual(await f.names('backups'), []);
  const mcp = await f.read('mcp.json');
  const record = ok(await f.run('manage.mjs', ['engine', 'codex']));
  assert.equal(record.verified, true);
  assert.deepEqual((await f.read(record.backup))['config.json'], before);
  assert.deepEqual(record.diff, [{ file: 'config.json', before, after: { ...before, engine: 'codex' } }]);
  assert.deepEqual(await f.read('mcp.json'), mcp);
  assert.equal(ok(await f.run('manage.mjs', ['status'])).engine, 'codex');
  assert.equal(ok(await f.run('manage.mjs', ['verify'])).engine, 'codex');
  ok(await f.run('manage.mjs', ['setup', f.url, before.device]));
  assert.deepEqual(await f.read('config.json'), { ...before, engine: 'codex' });
  assert.equal(record.restore, `node "\${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" restore ${record.backup.slice(8, -5)}`);
  ok(await f.run('manage.mjs', ['restore', record.backup.slice(8, -5)]));
  assert.deepEqual(await f.read('config.json'), before);
  assert.equal(ok(await f.run('manage.mjs', ['status'])).engine, 'claude');
  assert.equal(ok(await f.run('manage.mjs', ['verify'])).engine, 'claude');
  ok(await f.run('manage.mjs', ['engine', 'codex']));
  ok(await f.run('manage.mjs', ['engine', 'claude']));
  assert.equal((await f.read('config.json')).engine, 'claude');
});

test('Codex args exactly close configuration, tools, plugins, hooks and persistence', () => {
  const dir = '/tmp/synthetic directory';
  assert.deepEqual(pointsCodexArgs(dir), [
    '--no-daemon', '--strict-config', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', dir, '--json',
    '--output-last-message', join(dir, 'out.json'), '--output-schema', join(dir, 'output-schema.json'),
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}', '-c', 'history.persistence="none"',
    '-c', `log_dir=${JSON.stringify(join(dir, 'logs'))}`, '-c', `sqlite_home=${JSON.stringify(join(dir, 'state'))}`,
    '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false',
    '--disable', 'view_image', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'shell_snapshot',
    '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'hooks', '--disable', 'multi_agent',
    '--disable', 'memories', '--disable', 'goals', '--disable', 'browser_use', '--disable', 'computer_use',
    '--disable', 'image_generation', '--disable', 'code_mode', '--disable', 'standalone_web_search', '-',
  ]);
});

test('Codex terminal path sends the same contract, validated output and numeric usage with isolated env and private cleanup', async t => {
  const f = await seed(t);
  Object.assign(f.env, { USER: 'synthetic', LOGNAME: 'synthetic', CODEX_HOME: join(f.home, '.codex'),
    OPENAI_API_KEY: 'SYNTHETIC_FORBIDDEN', CLAUDE_CONFIG_DIR: 'SYNTHETIC_FORBIDDEN',
    CLAUDECODE: '1', HMP_EXTRACTOR_TOKEN: 'SYNTHETIC_FORBIDDEN' });
  const capture = join(f.home, 'capture-spawn.mjs');
  await writeFile(capture, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; import { writeFileSync } from 'node:fs';
const original = cp.spawn; cp.spawn = (file, args, options) => {
  if (file === 'codex') writeFileSync(process.env.HOME + '/spawn-env.json', JSON.stringify(options.env));
  return original(file, args, options);
}; syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS += ' --import=' + capture;
  ok(await f.run('worker.mjs'));
  const [launch] = await launches(f);
  assert.deepEqual(launch.args, pointsCodexArgs(launch.cwd));
  const spawnEnv = JSON.parse(await readFile(join(f.home, 'spawn-env.json'), 'utf8'));
  assert.deepEqual(Object.keys(spawnEnv).sort(), ['PATH', 'HOME', 'USER', 'LOGNAME', 'CODEX_HOME', 'TMPDIR'].sort());
  assert.ok(!JSON.stringify(spawnEnv).includes('SYNTHETIC_FORBIDDEN'));
  assert.equal(launch.env.HOME, f.home); assert.equal(launch.env.CODEX_HOME, f.env.CODEX_HOME);
  assert.equal(launch.env.TMPDIR, launch.cwd);
  assert.equal(launch.mode, 0o700); assert.equal(launch.mask, 0o077);
  assert.equal(launch.schemaMode, 0o600); assert.equal(launch.outMode, 0o600); assert.deepEqual(launch.schema, schema);
  const sent = f.requests.filter(r => r.url === '/api/client/points'); assert.equal(sent.length, 1);
  const body = sent[0].body;
  assert.equal(body.model, 'codex'); assert.deepEqual(body.points, [point]);
  assert.deepEqual(body.turn, Object.fromEntries(f.requests.filter(r => r.url === '/api/client/events')
    .flatMap(r => r.body.events).map(e => [e.kind, 'cap_' + e.client_event_id.slice(4)])));
  assert.equal(body.usage.input_tokens, 302); assert.equal(body.usage.output_tokens, 45);
  assert.ok(body.usage.duration_ms >= 0); assert.ok(body.usage.turn_ended_at > 0);
  const input = await readFile(join(f.home, 'codex-input'), 'utf8');
  assert.ok(input.includes(contract.instructions)); assert.ok(input.includes(JSON.stringify(body.sentences)));
  assert.match(input, /\nUNTRUSTED_TURN_([a-f0-9-]+)\n[^\n]+\nEND_UNTRUSTED_TURN_\1$/);
  const stats = (await f.read('points-stats.json'))[f.url][0];
  assert.equal(stats.engine, 'codex'); assert.equal(stats.input_tokens, 2); assert.equal(stats.cache_read_input_tokens, 300);
  assert.equal(stats.input_total_tokens, 302); assert.equal(stats.output_tokens, 45);
  assert.ok(!JSON.stringify(stats).includes(privateText)); assert.equal(stats.cache_creation_input_tokens, undefined);
  const status = ok(await f.run('manage.mjs', ['status']));
  assert.equal(status.points_stats.by_engine.codex.all.input_tokens_median, 2);
  assert.equal(status.points_stats.by_engine.claude.all.count, 0);
  assert.equal((await f.names('turns')).length, 0); await cleaned(f);
});

test('Codex and Claude receive identical stdin instructions and untrusted sentence framing', async t => {
  const f = await fixture(t, { claude: `const fs = require('node:fs'); let input = '';
process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
fs.writeFileSync(process.env.HOME + '/claude-input', input);
process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: output }))}); });` });
  await direct(f);
  const previous = process.env; process.env = f.env;
  try { await runPointsClaude(f.project, contract, [{ n: 1, part: 'prompt', text: '合成。' }], 1000, { binary: join(f.bin, 'claude') }); }
  finally { process.env = previous; }
  const normalize = value => value.replaceAll(/UNTRUSTED_TURN_[a-f0-9-]+/g, 'UNTRUSTED_TURN_BOUNDARY');
  assert.equal(normalize(await readFile(join(f.home, 'codex-input'), 'utf8')), normalize(await readFile(join(f.home, 'claude-input'), 'utf8')));
});

test('Codex usage reads only completed-turn numeric counters and tolerates unavailable or invalid counters', async t => {
  const f = await fixture(t);
  for (const [usage, expected] of [
    [counts, { input_tokens: 2, cache_read_input_tokens: 300, input_total_tokens: 302, output_tokens: 45 }],
    [{ input_tokens: 10, cached_input_tokens: 0, output_tokens: 0 }, { input_tokens: 10, cache_read_input_tokens: 0, input_total_tokens: 10, output_tokens: 0 }],
    [{ input_tokens: 3, cached_input_tokens: 4, output_tokens: -1 }, { input_total_tokens: 3 }],
    [{ input_tokens: Number.MAX_SAFE_INTEGER + 1, cached_input_tokens: 0, output_tokens: 1.5 }, {}],
    [{ input_tokens: '10', cached_input_tokens: null, output_tokens: 4 }, { output_tokens: 4 }],
    [{ input_tokens: 3 }, { input_total_tokens: 3 }], [null, {}],
  ]) {
    const events = [{ type: 'item.completed', usage: counts, item: { text: privateText } }, { type: 'turn.completed', usage }];
    const result = await direct(f, `require('node:fs').writeFileSync('out.json', ${JSON.stringify(JSON.stringify(output))});
process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n'))});`);
    assert.deepEqual(result.points, [point]);
    const { duration_ms, ...counters } = result.usage; assert.ok(duration_ms >= 0); assert.deepEqual(counters, expected);
  }
  const result = await direct(f, `require('node:fs').writeFileSync('out.json', ${JSON.stringify(JSON.stringify(output))}); process.stdout.write('malformed JSONL');`);
  assert.deepEqual(Object.keys(result.usage), ['duration_ms']); await cleaned(f);
});

test('Codex rejects invalid out.json even when stdout contains valid points, and always removes temporary state', async t => {
  const f = await fixture(t);
  for (const body of [
    `fs.writeFileSync('out.json', 'not JSON');`,
    `fs.writeFileSync('out.json', JSON.stringify({ points: [{ ...${JSON.stringify(point)}, extra: 'invalid' }] }));`,
    `fs.writeFileSync('out.json', JSON.stringify({ points: [{ ...${JSON.stringify(point)}, speaker: 'unknown' }] }));`,
    `fs.writeFileSync('out.json', 'x'.repeat(1024 * 1024 + 1));`,
    `fs.unlinkSync('out.json');`,
    `fs.unlinkSync('out.json'); fs.symlinkSync(process.env.HOME + '/.hmp/config.json', 'out.json');`,
  ]) {
    assert.deepEqual(await direct(f, `const fs = require('node:fs'); ${body}
process.stdout.write(${JSON.stringify(JSON.stringify(output))});`), { code: 'output_invalid' });
    await cleaned(f);
  }
});

for (const mode of ['codex_failed', 'codex_timeout', 'codex_unavailable', 'output_invalid', 'points_unavailable']) {
  test(`${mode} keeps the turn queued with a code and cooldown, without Claude fallback or retained model text`, async t => {
    const f = await seed(t); await cached(f, { max_seconds_per_turn: 1 });
    if (mode === 'codex_failed') await binary(f, `process.stderr.write(${JSON.stringify(privateText)}); process.exit(1);`);
    if (mode === 'codex_timeout') await binary(f, `setTimeout(() => {}, 30000);`);
    if (mode === 'codex_unavailable') await rm(join(f.bin, 'codex'));
    if (mode === 'output_invalid') await binary(f, `process.stdout.write(${JSON.stringify(JSON.stringify(output))});`);
    if (mode === 'points_unavailable') f.state.pointsFail = true;
    const before = await Promise.all((await f.names('sent')).map(n => f.read('sent/' + n)));
    ok(await f.run('worker.mjs'));
    assert.equal((await f.names('turns')).length, 1);
    assert.deepEqual(await Promise.all((await f.names('sent')).map(n => f.read('sent/' + n))), before);
    const retryName = (await f.names('turn-retries'))[0], retry = await f.read('turn-retries/' + retryName);
    assert.equal(retry.code, mode); assert.equal(retry.attempts, 1); assert.ok(retry.next_retry_at > Date.now());
    const status = ok(await f.run('manage.mjs', ['status'])); assert.equal(status.turns.last_failure, mode);
    assert.ok(!JSON.stringify(status).includes(privateText)); assert.ok(!JSON.stringify(retry).includes(privateText));
    assert.equal(f.requests.filter(r => r.url === '/api/client/points').length, mode === 'points_unavailable' ? 1 : 0);
    await binary(f); f.state.pointsFail = false;
    ok(await f.run('worker.mjs')); assert.equal((await f.names('turns')).length, 1);
    await f.write('turn-retries/' + retryName, { ...retry, next_retry_at: 0 });
    ok(await f.run('worker.mjs')); assert.equal((await f.names('turns')).length, 0); await cleaned(f);
  });
}

test('non-executable Codex is unavailable and does not change the parent umask', async t => {
  const f = await fixture(t), path = join(f.bin, 'not-executable');
  await writeFile(path, 'synthetic', { mode: 0o600 });
  const mask = process.umask();
  assert.deepEqual(await runPointsCodex(contract, [], 1000, { binary: path, tempRoot: f.home }), { code: 'codex_unavailable' });
  assert.equal(process.umask(), mask); await cleaned(f);
});

test('Codex timeout kills descendant processes before temporary files are removed', async t => {
  const f = await fixture(t);
  const tick = join(f.home, 'ticks'), pidFile = join(f.home, 'descendant-pid');
  t.after(async () => {
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  const body = `const fs = require('node:fs'); const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs = require('node:fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(tick)}, '.'), 10);`)}], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
  assert.deepEqual(await direct(f, body, 1000), { code: 'codex_timeout' });
  const before = await readFile(tick, 'utf8'); assert.ok(before.length > 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await readFile(tick, 'utf8'), before); await cleaned(f);
});

test('offrecord status shows engine locally and retains its notice when config cannot be read', async t => {
  const f = await fixture(t);
  ok(await f.run('manage.mjs', ['engine', 'codex']));
  await f.write('offrecord/synthetic-session', {});
  let status = ok(await f.run('manage.mjs', ['status', 'synthetic-session']));
  assert.equal(status.engine, 'codex'); assert.equal(status.offrecord, true); assert.deepEqual(f.requests, []);
  await rm(join(f.home, '.hmp/config.json'));
  status = ok(await f.run('manage.mjs', ['status', 'synthetic-session']));
  assert.equal(status.engine, null); assert.equal(status.notice, 'このセッションはオフレコ'); assert.deepEqual(f.requests, []);
});

for (const mode of ['pause', 'offrecord']) {
  test(`Codex rechecks ${mode} after extraction before sending`, async t => {
    const f = await seed(t);
    const effect = mode === 'pause' ? `fs.writeFileSync(process.env.HOME + '/.hmp/pause', JSON.stringify({ until: new Date(Date.now() + 60000).toISOString() }));`
      : `fs.mkdirSync(process.env.HOME + '/.hmp/offrecord', { recursive: true }); fs.writeFileSync(process.env.HOME + '/.hmp/offrecord/synthetic-session', '{}');`;
    await binary(f, `const fs = require('node:fs'); ${effect} fs.writeFileSync('out.json', ${JSON.stringify(JSON.stringify(output))});`);
    ok(await f.run('worker.mjs'));
    assert.equal(f.requests.filter(r => r.url === '/api/client/points').length, 0);
    assert.equal((await f.names('turns')).length, mode === 'pause' ? 1 : 0);
    await cleaned(f);
  });
}

test('Codex engine leaves MCP backlog and line work on Claude', async t => {
  const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'hmp', status: 'connected' }], tools: [...POINT_TOOLS, ...LINE_TOOLS] };
  const f = await fixture(t, { remote: { points: { ...contract, backlog: 1 }, pending: { lines: 1 } },
    claude: `const fs = require('node:fs'); fs.appendFileSync(process.env.HOME + '/mcp-launches', JSON.stringify(process.argv.slice(2)) + '\\n');
${mcpEvents([init, { type: 'result', subtype: 'success', is_error: false }])}` });
  ok(await f.run('manage.mjs', ['engine', 'codex'])); await cached(f); await binary(f);
  await f.write('mcp-tools.json', { [f.url]: [...POINT_TOOLS, ...LINE_TOOLS] });
  ok(await f.run('worker.mjs'));
  assert.deepEqual(await launches(f), []);
  const args = (await readFile(join(f.home, 'mcp-launches'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(args.length, 2);
  for (const [i, tools] of [POINT_TOOLS, LINE_TOOLS].entries()) {
    const start = args[i].indexOf('--allowedTools') + 1;
    assert.deepEqual(args[i].slice(start, args[i].findIndex((arg, index) => index >= start && arg.startsWith('--'))), tools);
  }
});
