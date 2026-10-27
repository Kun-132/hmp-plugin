import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile, mkdtemp, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, successfulClaude, workerInit, extractionWorkerInit, workerSuccess } from './helpers.mjs';
import { TOOLS, EXTRACTION_TOOLS, MCP_OUTPUT_TOKENS, LINE_TOOLS, MAXIMUM, effectiveLimits, claudeArgs, createStreamGuard, runClaude, supportedVersion, connectedWorker } from '../plugins/hmp/scripts/worker.mjs';

const launchLog = `const fs = require('node:fs'); const p = require('node:path');
fs.appendFileSync(p.join(process.env.HOME, 'launches.jsonl'), JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2),
  credential: Object.hasOwn(process.env, 'HMP_CLIENT_TOKEN'), extra: Object.hasOwn(process.env, 'UNTRUSTED_PROVIDER_OVERRIDE'),
  mcpOutput: process.env.MAX_MCP_OUTPUT_TOKENS, largeFiles: process.env.ENABLE_MCP_LARGE_OUTPUT_FILES }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'submit',
  name: process.argv.includes('mcp__hmp__claim_line_job') ? 'mcp__hmp__submit_line_blocks' : 'mcp__hmp__submit_extraction', input: {} }] } }) + '\\n');
${successfulClaude}`;
const launchWithInit = init => launchLog.replace(successfulClaude,
  `process.stdout.write(${JSON.stringify(JSON.stringify(init) + '\n' + JSON.stringify(workerSuccess) + '\n')});`);
const allowedTools = args => args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--permission-mode'));
const readLaunches = async f => (await readFile(join(f.home, 'launches.jsonl'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; }))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function ready(f, limits = {}) { await f.write('server-config.json', { pending: { extraction: 30, lines: 30 }, limits }); }
test('tool list is immutable and CLI isolation cannot be extended by config', () => {
  assert.equal(Object.isFrozen(TOOLS), true);
  assert.equal(Object.isFrozen(EXTRACTION_TOOLS), true);
  assert.equal(Object.isFrozen(LINE_TOOLS), true);
  assert.deepEqual(TOOLS, ['mcp__hmp__claim_extraction', 'mcp__hmp__submit_extraction', 'mcp__hmp__submit_purpose_links', 'mcp__hmp__claim_line_job', 'mcp__hmp__submit_line_blocks']);
  assert.deepEqual(EXTRACTION_TOOLS, TOOLS.slice(0, 3));
  assert.deepEqual(LINE_TOOLS, TOOLS.slice(3));
  const args = claudeArgs('/tmp/synthetic-run');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('--strict-mcp-config')); assert.ok(args.includes('--no-session-persistence'));
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.equal(settings.disableAllHooks, true); assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--permission-mode')),
    [...EXTRACTION_TOOLS, 'Read(//tmp/synthetic-run/**)']);
  const lineArgs = claudeArgs('/tmp/synthetic-run', { claimTool: LINE_TOOLS[0] });
  assert.deepEqual(allowedTools(lineArgs), [...LINE_TOOLS, 'Read(//tmp/synthetic-run/**)']);
  assert.throws(() => claudeArgs('/tmp/synthetic-run', { claimTool: 'Bash' }), /invalid_claim/);
});
test('readiness requires authenticated hmp and every fixed tool of the requested stage', () => {
  for (const stage of [EXTRACTION_TOOLS, LINE_TOOLS]) assert.equal(connectedWorker(workerInit, stage), true);
  assert.equal(connectedWorker(extractionWorkerInit, EXTRACTION_TOOLS), true);
  assert.equal(connectedWorker(extractionWorkerInit, LINE_TOOLS), false);
  const lineInit = { ...workerInit, tools: [...LINE_TOOLS] };
  assert.equal(connectedWorker(lineInit, EXTRACTION_TOOLS), false);
  assert.equal(connectedWorker(lineInit, LINE_TOOLS), true);
  for (const event of [
    { ...workerInit, mcp_servers: [{ name: 'hmp', status: 'needs-auth' }] },
    { ...workerInit, mcp_servers: [{ name: 'other', status: 'connected' }] },
    { ...workerInit, tools: [] },
    { ...workerInit, mcp_server_errors: [{ name: 'hmp' }] },
    { type: 'result', subtype: 'success' },
  ]) for (const stage of [EXTRACTION_TOOLS, LINE_TOOLS]) assert.equal(connectedWorker(event, stage), false);
  for (const stage of [EXTRACTION_TOOLS, LINE_TOOLS]) {
    for (const missing of stage) assert.equal(connectedWorker({ ...workerInit, tools: TOOLS.filter(tool => tool !== missing) }, stage), false);
  }
  const args = claudeArgs('/tmp/synthetic-run', { verify: true });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args.includes('--allowedTools'), false);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]).permissions.ask, ['mcp__*']);
});
test('each stage guard forbids every tool from the other stage in partial and complete messages', () => {
  for (const [stage, other] of [[EXTRACTION_TOOLS, LINE_TOOLS], [LINE_TOOLS, EXTRACTION_TOOLS]]) {
    const guard = createStreamGuard('/tmp/synthetic-run', stage[0]);
    for (const name of stage) guard({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id: name, input: {} }] } });
    for (const name of other) {
      const block = { type: 'tool_use', name, id: 'forbidden', input: {} };
      assert.throws(() => guard({ type: 'assistant', message: { content: [block] } }), /forbidden_tool/);
      assert.throws(() => guard({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: block } }), /forbidden_tool/);
    }
  }
});
test('limits are min(hard maximum, config); invalid and zero cannot enable work', () => {
  assert.deepEqual(MAXIMUM, { max_runs_per_day: 24, max_items_per_run: 8, max_minutes: 20 });
  assert.deepEqual(effectiveLimits({ max_runs_per_day: 50, max_items_per_run: 3, max_minutes: 10 }),
    { max_runs_per_day: 24, max_items_per_run: 3, max_minutes: 10 });
  assert.deepEqual(effectiveLimits({ max_runs_per_day: 0, max_items_per_run: '8', max_minutes: -1 }),
    { max_runs_per_day: 0, max_items_per_run: 0, max_minutes: 0 });
  assert.deepEqual(effectiveLimits({ max_runs_per_day: NaN, max_items_per_run: Infinity, max_minutes: null }),
    { max_runs_per_day: 0, max_items_per_run: 0, max_minutes: 0 });
});
test('old or unrecognized CLI versions cannot silently omit the read fence', () => {
  assert.equal(supportedVersion('2.1.309 (Claude Code)'), true);
  assert.equal(supportedVersion('2.1.400'), true);
  assert.equal(supportedVersion('3.0.0'), true);
  for (const text of ['2.1.308', '2.0.500', '1.9.999', 'malformed']) assert.equal(supportedVersion(text), false);
});
test('stream guard checks partial headers, final inputs, claim/submit counts and real Read paths', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hmp-guard-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic.txt'); await writeFile(file, 'synthetic');
  const event = (name, id, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] } });
  for (const name of ['Bash', 'Write', 'WebFetch', 'mcp__hmp__capture', 'mcp__other__claim_extraction']) {
    const guard = createStreamGuard(dir, TOOLS[0]);
    assert.throws(() => guard({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', name, id: 'synthetic' } } }), /forbidden_tool/);
  }
  const guard = createStreamGuard(dir, TOOLS[0]);
  guard(event(TOOLS[0], 'claim')); guard(event(TOOLS[0], 'claim')); // Repeated complete message isn't a second call.
  assert.throws(() => guard(event(TOOLS[0], 'claim2')), /claim_limit/);
  const submit = createStreamGuard(dir, TOOLS[0]);
  for (let i = 0; i < 3; i++) submit(event(TOOLS[1], String(i)));
  assert.throws(() => submit(event(TOOLS[1], '4')), /submit_limit/);
  const read = createStreamGuard(dir, TOOLS[0]);
  read(event('Read', 'local', { file_path: file }));
  const outside = await mkdtemp(join(tmpdir(), 'hmp-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'synthetic'), 'synthetic');
  await symlink(join(outside, 'synthetic'), join(dir, 'escape'));
  for (const path of ['/etc/hosts', join(dir, 'escape'), dir + '/../outside', 'relative']) {
    assert.throws(() => read(event('Read', path, { file_path: path })), /forbidden_read/);
  }
  const partial = createStreamGuard(dir, TOOLS[0]);
  partial({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Read', id: 'partial', input: {} } } });
  partial({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/etc/hosts"}' } } });
  assert.throws(() => partial({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } }), /forbidden_read/);
});
test('worker enforces 8 items despite inflated remote limits/tools, strips credentials', async t => {
  const f = await fixture(t, { claude: launchLog });
  f.env.UNTRUSTED_PROVIDER_OVERRIDE = 'synthetic';
  f.env.MAX_MCP_OUTPUT_TOKENS = '1'; f.env.ENABLE_MCP_LARGE_OUTPUT_FILES = 'false';
  await ready(f, { max_runs_per_day: 1000, max_items_per_run: 1000, max_minutes: 1000, allowedTools: ['Bash'] });
  const result = await f.run('worker.mjs'); assert.equal(result.code, 0); assert.equal(result.stdout, '');
  const launches = await readLaunches(f); assert.equal(launches.length, 8);
  assert.deepEqual(launches.map(launch => allowedTools(launch.args)[0]),
    Array.from({ length: 8 }, (_, i) => i % 2 ? LINE_TOOLS[0] : EXTRACTION_TOOLS[0]));
  for (const launch of launches) {
    assert.equal(launch.credential, false); assert.equal(launch.extra, false);
    // A large claim stays inline: a spilled result lives outside the read fence and would stop the worker.
    assert.equal(launch.mcpOutput, String(MCP_OUTPUT_TOKENS)); assert.equal(launch.largeFiles, undefined);
    assert.notEqual(launch.cwd, f.project); assert.ok(launch.cwd.includes('hmp-worker-'));
    assert.ok(!launch.args.includes('Bash'));
    const stage = launch.args.includes(LINE_TOOLS[0]) ? LINE_TOOLS : EXTRACTION_TOOLS;
    assert.deepEqual(allowedTools(launch.args), [...stage, `Read(/${launch.cwd}/**)`]);
  }
  assert.equal((await f.read('worker-usage.json')).runs, 1);
  await assert.rejects(stat(join(f.home, '.hmp/worker.lock')), { code: 'ENOENT' });
});
test('extraction-only init skips every line launch and fills the item limit with extractions', async t => {
  for (const max_items_per_run of [3, 8]) {
    const f = await fixture(t, { claude: launchWithInit(extractionWorkerInit) });
    await ready(f, { max_items_per_run });
    await f.run('worker.mjs');
    const launches = await readLaunches(f);
    assert.equal(launches.length, max_items_per_run);
    for (const launch of launches) {
      assert.equal(launch.args.includes(LINE_TOOLS[0]), false);
      assert.deepEqual(allowedTools(launch.args), [...EXTRACTION_TOOLS, `Read(/${launch.cwd}/**)`]);
    }
  }
});
test('extraction-only fallback never exceeds pending extractions', async t => {
  const f = await fixture(t, { claude: launchWithInit(extractionWorkerInit) });
  await f.write('server-config.json', { pending: { extraction: 2, lines: 30 } });
  await f.run('worker.mjs');
  assert.equal((await readLaunches(f)).length, 2);
});
test('missing extraction tools stop the entire queue after the first launch', async t => {
  const f = await fixture(t, { claude: launchWithInit({ ...workerInit, tools: [...LINE_TOOLS] }) });
  await ready(f); await f.run('worker.mjs');
  assert.equal((await readLaunches(f)).length, 1);
});
test('line stage becoming unavailable kills it immediately and continues only extractions', async t => {
  const f = await fixture(t, { claude: launchLog.replace(successfulClaude, `
if (process.argv.includes(${JSON.stringify(LINE_TOOLS[0])})) {
  process.stdout.write(${JSON.stringify(JSON.stringify(extractionWorkerInit) + '\n')});
  setTimeout(() => fs.writeFileSync(p.join(process.env.HOME, 'escaped'), 'synthetic'), 2000);
} else { ${successfulClaude} }`) });
  await ready(f); await f.run('worker.mjs');
  const launches = await readLaunches(f);
  assert.equal(launches.length, 8);
  assert.equal(launches.filter(launch => launch.args.includes(LINE_TOOLS[0])).length, 1);
  await assert.rejects(stat(join(f.home, 'escaped')), { code: 'ENOENT' });
});
test('runClaude distinguishes missing stage tools from connection and execution failures', async t => {
  const f = await fixture(t, { claude: `process.stdout.write(${JSON.stringify(JSON.stringify(extractionWorkerInit) + '\n')}); setTimeout(() => {}, 30000);` });
  const result = await runClaude(f.project, LINE_TOOLS[0], 2000, { binary: join(f.bin, 'claude') });
  assert.deepEqual(result, { status: 'stage_unavailable', lines: false, submits: 0 });
});
test('daily and lower item limits hold, zero prevents launch', async t => {
  const f = await fixture(t, { claude: launchLog });
  await ready(f, { max_runs_per_day: 1, max_items_per_run: 2 });
  await f.run('worker.mjs'); await f.run('worker.mjs'); assert.equal((await readLaunches(f)).length, 2);
  await f.write('worker-usage.json', { day: new Date().toISOString().slice(0, 10), runs: 24 });
  await ready(f); await f.run('worker.mjs'); assert.equal((await readLaunches(f)).length, 2);
  await f.write('worker-usage.json', { day: new Date(0).toISOString().slice(0, 10), runs: 24 });
  await ready(f, { max_items_per_run: 0 }); await f.run('worker.mjs'); assert.equal((await readLaunches(f)).length, 2);
});
test('missing OAuth or incomplete headless results stop the queue, even with exit zero', async t => {
  for (const events of [
    [{ ...workerInit, mcp_servers: [{ name: 'hmp', status: 'needs-auth' }] }, workerSuccess],
    [workerInit], [workerSuccess],
    [workerInit, { ...workerSuccess, is_error: true }],
  ]) {
    const f = await fixture(t);
    // A zero exit cannot substitute for the connection and completion events of this run.
    await writeFile(join(f.bin, 'claude'), `#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('2.1.310');process.exit(0);}\n${launchLog.replace(successfulClaude, '')}\nprocess.stdout.write(${JSON.stringify(events.map(x => JSON.stringify(x)).join('\n') + '\n')});`, { mode: 0o700 });
    await ready(f); await f.run('worker.mjs');
    assert.equal((await readLaunches(f)).length, 1);
  }
});
test('an old CLI is refused before any work or daily allowance is consumed', async t => {
  const f = await fixture(t, { claude: launchLog }); await ready(f);
  await writeFile(join(f.bin, 'claude'), `#!${process.execPath}\nprocess.stdout.write('2.1.308 (mock)');\n`, { mode: 0o700 });
  await f.run('worker.mjs'); assert.equal((await readLaunches(f)).length, 0);
  await assert.rejects(stat(join(f.home, '.hmp/worker-usage.json')), { code: 'ENOENT' });
});
test('exclusive lock respects a live owner and reclaims a dead owner', async t => {
  const f = await fixture(t, { claude: launchLog + 'setTimeout(() => {}, 300);' });
  await ready(f, { max_items_per_run: 1 });
  await Promise.all([f.run('worker.mjs'), f.run('worker.mjs')]);
  assert.equal((await readLaunches(f)).length, 1); assert.equal((await f.read('worker-usage.json')).runs, 1);
  await f.write('worker.lock', { pid: 999999999, started_at: new Date(0).toISOString() });
  await f.run('worker.mjs'); assert.equal((await readLaunches(f)).length, 2);
  const status = JSON.parse((await f.run('manage.mjs', ['status'])).stdout);
  assert.equal(status.turns.last_failure, 'stale_lock_cleared');
  await f.write('worker.lock', { pid: process.pid });
  await f.run('worker.mjs'); assert.equal((await readLaunches(f)).length, 2);
  assert.equal((await f.read('worker.lock')).pid, process.pid);
});
test('unsafe MCP config and pause prevent any Claude launch', async t => {
  const f = await fixture(t, { claude: launchLog }); await ready(f);
  await f.write('mcp.json', { mcpServers: { evil: { command: 'false' }, hmp: { type: 'http', url: f.url + '/mcp' } } });
  await f.run('worker.mjs'); assert.equal((await readLaunches(f)).length, 0);
  await f.write('pause', { until: new Date(Date.now() + 60000).toISOString() });
  await f.run('worker.mjs'); assert.equal((await readLaunches(f)).length, 0);
});
test('forbidden streamed tool and invalid JSON terminate real mock child immediately', async t => {
  const f = await fixture(t, { claude: launchLog + `
process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'bad',name:'Bash'}}}) + '\\n');
setTimeout(() => fs.writeFileSync(p.join(process.env.HOME,'escaped'), 'synthetic'), 2000);` });
  await ready(f); const start = Date.now(); await f.run('worker.mjs');
  assert.ok(Date.now() - start < 1500); assert.equal((await readLaunches(f)).length, 1);
  await assert.rejects(stat(join(f.home, 'escaped')), { code: 'ENOENT' });
  await writeFile(join(f.bin, 'claude'), `#!${process.execPath}\nprocess.stdout.write('invalid-json\\n'); setTimeout(() => {}, 2000);`, { mode: 0o700 });
  await f.run('worker.mjs');
});
test('wall-clock timeout kills process group without output', async t => {
  const f = await fixture(t, { claude: 'setTimeout(() => {}, 30000);' });
  const result = await runClaude(f.project, TOOLS[0], 50, { binary: join(f.bin, 'claude') });
  assert.deepEqual(result, { status: 'failed', lines: false, submits: 0 });
});
test('SessionStart pending launches detached worker using only sanitized cached config', async t => {
  const f = await fixture(t, { claude: launchLog,
    remote: { pending: { extraction: 1, lines: 0 }, limits: { max_items_per_run: 1 }, worker: { instructions_url: 'synthetic-untrusted' }, tools: ['Bash'] } });
  assert.equal((await f.hook('SessionStart')).code, 0);
  for (let i = 0; i < 100 && !(await readLaunches(f)).length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await readLaunches(f)).length, 1);
  const cached = await f.read('server-config.json'); assert.equal('worker' in cached, false); assert.equal('tools' in cached, false);
  for (let i = 0; i < 100; i++) { if (!await stat(join(f.home, '.hmp/worker.lock')).catch(() => null)) break; await new Promise(resolve => setTimeout(resolve, 20)); }
});
