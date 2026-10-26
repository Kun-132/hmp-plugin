import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, workerInit, workerSuccess, successfulClaude } from './helpers.mjs';
import { validateConfig, validateMcp, loadToken } from '../plugins/hmp/scripts/config.mjs';

test('config accepts HTTPS/loopback, refuses unsafe URLs and devices', () => {
  assert.deepEqual(validateConfig({ instance_url: 'https://hmp.example/', device: 'synthetic-mac' }), { instance_url: 'https://hmp.example', device: 'synthetic-mac' });
  for (const instance_url of ['http://hmp.example', 'https://u:p@hmp.example', 'https://hmp.example/x', 'https://hmp.example/?token=synthetic', 'file:///tmp/x']) {
    assert.throws(() => validateConfig({ instance_url, device: 'test' }));
  }
  assert.throws(() => validateConfig({ instance_url: 'https://hmp.example', device: 'bad device' }));
  const config = { instance_url: 'https://hmp.example' };
  assert.deepEqual(validateMcp({ mcpServers: { hmp: { url: 'https://hmp.example/mcp', type: 'http' } } }, config),
    { mcpServers: { hmp: { type: 'http', url: 'https://hmp.example/mcp' } } });
  assert.throws(() => validateMcp({ mcpServers: { hmp: { type: 'http', url: 'https://hmp.example/mcp', headersHelper: 'false' } } }, config));
  assert.throws(() => validateMcp({ mcpServers: { hmp: { type: 'http', url: 'https://hmp.example/mcp', headers: { Authorization: 'Bearer synthetic' } } } }, config));
});
test('token source is keychain only on macOS, environment only elsewhere', async () => {
  let calls = [];
  const run = async (...args) => { calls.push(args); return { stdout: 'synthetic\n' }; };
  const config = { device: 'mock-device', instance_url: 'https://synthetic.example' };
  const lookup = async account => account === 'mock-device@synthetic.example' ? { origin: config.instance_url } : null;
  assert.equal(await loadToken(config, { platform: 'darwin', run, lookup, env: { HMP_CLIENT_TOKEN: 'other' } }), 'synthetic');
  assert.deepEqual(calls[0].slice(0, 2), ['security', ['find-generic-password', '-s', 'hmp-client', '-a', 'mock-device@synthetic.example', '-w']]);
  assert.equal(await loadToken(config, { platform: 'darwin', lookup, run: async () => { throw Error(); }, env: { HMP_CLIENT_TOKEN: 'other' } }), null);
  calls = [];
  assert.equal(await loadToken(config, { platform: 'linux', run, env: { HMP_CLIENT_TOKEN: 'synthetic', HMP_CLIENT_ORIGIN: config.instance_url } }), 'synthetic');
  assert.equal(await loadToken(config, { platform: 'linux', run, env: { HMP_CLIENT_TOKEN: 'synthetic' } }), null);
  assert.equal(await loadToken(config, { platform: 'linux', run, env: { HMP_CLIENT_TOKEN: 'synthetic', HMP_CLIENT_ORIGIN: 'https://other.example' } }), null);
  assert.equal(calls.length, 0);
});
test('setup backs up, records diff/rollback, verifies bytes and instance label; restore works', async t => {
  const f = await fixture(t, { remote: { instance_label: '合成テスト用 HMP' } });
  const before = await f.read('config.json');
  const result = await f.run('manage.mjs', ['setup', 'https://synthetic.example', 'new-device']);
  assert.equal(result.code, 0);
  const record = JSON.parse(result.stdout); assert.equal(record.verified, true);
  assert.deepEqual(record.keychain_command, ['security', 'add-generic-password', '-s', 'hmp-client', '-a', 'new-device@synthetic.example', '-w']);
  assert.deepEqual((await f.read(record.backup))['config.json'], before);
  assert.ok(record.restore.includes('restore'));
  const id = record.backup.split('/')[1].replace('.json', '');
  assert.equal((await stat(join(f.home, '.hmp', record.backup))).mode & 0o777, 0o600);
  assert.equal((await f.run('manage.mjs', ['restore', id])).code, 0);
  assert.deepEqual(await f.read('config.json'), before);
  const verified = await f.run('manage.mjs', ['verify']); assert.equal(verified.code, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).instance_label, '合成テスト用 HMP');
  assert.deepEqual(JSON.parse(verified.stdout).worker, { ready: true, server: 'hmp', url: f.url + '/mcp' });
});
test('verify uses worker credentials/config isolation and removes its temporary working directory', async t => {
  const f = await fixture(t, { claude: `const fs = require('node:fs');
fs.writeFileSync(process.env.HOME + '/probe.json', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), env: process.env }));
${successfulClaude}` });
  f.env.CLAUDE_CONFIG_DIR = join(f.home, 'synthetic-claude-config');
  f.env.HMP_EXTRACTOR_TOKEN = 'synthetic-extractor-token';
  f.env.ANTHROPIC_API_KEY = 'synthetic-provider-override';
  const result = await f.run('manage.mjs', ['verify']);
  assert.equal(result.code, 0, JSON.stringify({ stderr: result.stderr, requests: f.requests.map(request => request.url) }));
  const { readFile } = await import('node:fs/promises');
  const probe = JSON.parse(await readFile(join(f.home, 'probe.json'), 'utf8'));
  assert.equal(probe.args[probe.args.indexOf('--mcp-config') + 1], join(f.home, '.hmp/mcp.json'));
  assert.equal(probe.env.CLAUDE_CONFIG_DIR, f.env.CLAUDE_CONFIG_DIR);
  for (const key of ['HMP_CLIENT_TOKEN', 'HMP_EXTRACTOR_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(key in probe.env, false);
  assert.equal(probe.args.includes('--allowedTools'), false);
  await assert.rejects(stat(probe.cwd), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.home, '.hmp/worker-usage.json')), { code: 'ENOENT' });
  assert.deepEqual(f.requests.map(x => x.url), ['/api/client/config']);
});
test('verify fails closed for missing OAuth, missing tools, model login errors and tool attempts', async t => {
  const cases = [
    [{ ...workerInit, mcp_servers: [{ name: 'hmp', status: 'needs-auth' }] }, workerSuccess],
    [{ ...workerInit, tools: workerInit.tools.slice(1) }, workerSuccess],
    [workerInit, { ...workerSuccess, subtype: 'error_during_execution', is_error: true, result: 'synthetic-secret' }],
    [workerInit, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__hmp__claim_extraction', id: 'synthetic' } } }, workerSuccess],
    [],
  ];
  for (const events of cases) {
    const f = await fixture(t, { claude: `process.stdout.write(${JSON.stringify(events.map(x => JSON.stringify(x)).join('\n') + '\n')});` });
    const result = await f.run('manage.mjs', ['verify']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, ''); assert.ok(!result.stderr.includes('synthetic-secret'));
  }
});
test('setup never backs up unknown secret fields', async t => {
  const f = await fixture(t);
  await f.write('config.json', { instance_url: f.url, device: 'test', token: 'SYNTHETIC_UNSAFE_FIELD' });
  const result = await f.run('manage.mjs', ['setup', 'https://synthetic.example', 'test']);
  assert.equal(result.code, 1); assert.ok(!result.stderr.includes('SYNTHETIC_UNSAFE_FIELD'));
  assert.equal((await f.names('backups')).length, 0);
});
test('pause and resume record changes, status returns only metadata', async t => {
  const f = await fixture(t, { remote: { pending: { extraction: 4, lines: 2 }, text: 'SYNTHETIC_SERVER_TEXT' } });
  assert.equal((await f.run('manage.mjs', ['pause', '5'])).code, 0);
  assert.ok(Date.parse((await f.read('pause')).until) > Date.now());
  assert.equal((await f.run('manage.mjs', ['pause', '0'])).code, 0);
  assert.ok(Date.parse((await f.read('pause')).until) <= Date.now());
  const status = await f.run('manage.mjs', ['status']); assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout), { client_version: '0.1.1', spool: 0, spool_held: 0, last_send: null, pending: { extraction: 4, lines: 2 } });
});
async function history(f) {
  const dir = join(f.home, '.claude/projects/synthetic-project'); await mkdir(dir, { recursive: true });
  const rows = [
    { type: 'user', uuid: 'turn1', message: { role: 'user', content: [{ type: 'text', text: '合成質問 api_key="SYNTHETIC_KEY"' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SYNTHETIC_INTERMEDIATE' }, { type: 'tool_use', name: 'Read', input: {} }], stop_reason: 'tool_use' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'SYNTHETIC_TOOL_RESULT' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SYNTHETIC_THINKING' }, { type: 'text', text: '合成最終回答' }], stop_reason: 'end_turn' } },
    { type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: 'SYNTHETIC_META' } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: 'SYNTHETIC_SIDECHAIN' } },
    { type: 'user', uuid: 'outside', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'SYNTHETIC_OUTSIDE' } },
  ];
  await writeFile(join(dir, 'synthetic-session.jsonl'), rows.map(row => JSON.stringify({ cwd: f.project, timestamp: '2026-10-01T03:00:00Z', sessionId: 'synthetic-session', ...row })).join('\n'));
}
test('onboard previews without sending; explicit approval sends only user/final assistant text with kinds', async t => {
  const f = await fixture(t); await history(f);
  const args = ['preview', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'];
  const result = await f.run('onboard.mjs', args); assert.equal(result.code, 0);
  const plan = JSON.parse(result.stdout); assert.equal(plan.count, 2); assert.equal(f.requests.length, 0);
  const saved = JSON.stringify(await f.read(`onboard/${plan.plan}.json`));
  for (const excluded of ['SYNTHETIC_KEY', 'SYNTHETIC_INTERMEDIATE', 'SYNTHETIC_TOOL_RESULT', 'SYNTHETIC_THINKING', 'SYNTHETIC_META', 'SYNTHETIC_SIDECHAIN', 'SYNTHETIC_OUTSIDE']) assert.ok(!saved.includes(excluded));
  assert.equal((await f.run('onboard.mjs', ['send', plan.plan, '2'])).code, 1); assert.equal(f.requests.length, 0);
  assert.equal((await f.run('onboard.mjs', ['send', plan.plan, '3', '--approved'])).code, 1); assert.equal(f.requests.length, 0);
  const sent = await f.run('onboard.mjs', ['send', plan.plan, '2', '--approved']); assert.equal(sent.code, 0);
  assert.deepEqual(f.requests[0].body.events.map(x => x.kind), ['prompt', 'response']);
  assert.deepEqual(f.requests[0].body.events.map(x => x.session), ['synthetic-session', 'synthetic-session']);
  assert.equal(f.requests[0].body.events[1].text, '合成最終回答');
  const again = JSON.parse((await f.run('onboard.mjs', args)).stdout);
  assert.equal((await f.run('onboard.mjs', ['send', again.plan, '2', '--approved'])).code, 0);
  assert.equal(f.seen.size, 2);
});
test('onboard rechecks source exclusion after approval preview and never queues it', async t => {
  const f = await fixture(t); await history(f);
  const plan = JSON.parse((await f.run('onboard.mjs', ['preview', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'])).stdout);
  await writeFile(join(f.project, '.hmp-ignore'), '');
  assert.equal((await f.run('onboard.mjs', ['send', plan.plan, String(plan.count), '--approved'])).code, 1);
  assert.equal(f.requests.length, 0); assert.equal((await f.names('spool')).length, 0);
});
test('onboard rejects plans created for another origin or without origin metadata', async t => {
  const f = await fixture(t); await history(f);
  const plan = JSON.parse((await f.run('onboard.mjs', ['preview', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'])).stdout);
  const stored = await f.read(`onboard/${plan.plan}.json`);
  assert.equal(stored.instance_origin, f.url);
  await f.run('manage.mjs', ['setup', f.url.replace('127.0.0.1', 'localhost'), 'synthetic-device']);
  assert.equal((await f.run('onboard.mjs', ['send', plan.plan, String(plan.count), '--approved'])).code, 1);
  await f.run('manage.mjs', ['setup', f.url, 'synthetic-device']);
  delete stored.instance_origin; await f.write(`onboard/${plan.plan}.json`, stored);
  assert.equal((await f.run('onboard.mjs', ['send', plan.plan, String(plan.count), '--approved'])).code, 1);
  assert.equal(f.requests.length, 0); assert.equal((await f.names('spool')).length, 0);
});
test('manual verify waits for a slow server; hook requests keep their short cap', async t => {
  const f = await fixture(t, { remote: { instance_label: '合成テスト用 HMP' } });
  f.state.delayMs = 1500;
  const started = Date.now();
  const verified = await f.run('manage.mjs', ['verify']);
  assert.equal(verified.code, 0); assert.equal(JSON.parse(verified.stdout).connected, true);
  assert.ok(Date.now() - started >= 1500);
  const { request } = await import('../plugins/hmp/scripts/client.mjs');
  await assert.rejects(request({ instance_url: f.url }, 'synthetic-token', '/api/client/config'));
});
