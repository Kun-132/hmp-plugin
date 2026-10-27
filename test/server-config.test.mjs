import test from 'node:test';
import assert from 'node:assert/strict';
import { utimes, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';

const hour = 3600_000;
const quiet = result => assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
const configRequests = f => f.requests.filter(r => r.url === '/api/client/config');
const hook = (f, client, event, input = {}) => f.run('hook.mjs', [event, ...(client === 'codex' ? ['codex'] : [])], {
  cwd: f.project, session_id: 'synthetic-session', prompt_id: 'synthetic-turn', turn_id: 'synthetic-turn',
  prompt: 'SYNTHETIC_PROMPT', last_assistant_message: 'SYNTHETIC_RESPONSE', ...input,
});
async function stale(f, value = { instance_origin: f.url }) {
  await f.write('server-config.json', value);
  const old = new Date(Date.now() - hour - 1000);
  await utimes(join(f.home, '.hmp/server-config.json'), old, old);
}

for (const client of ['claude', 'codex']) {
  for (const event of ['UserPromptSubmit', 'Stop']) {
    for (const mode of ['missing', 'unbound', 'foreign', 'stale']) {
      test(`${client} ${event} refreshes ${mode} config and records points work without SessionStart`, async t => {
        const f = await fixture(t, { remote: { points: { backlog: 0 }, text: 'SYNTHETIC_PRIVATE', id: 'SYNTHETIC_ID' } });
        await f.write('worker.lock', { pid: process.pid });
        if (mode === 'unbound') await f.write('server-config.json', { pending: {} });
        if (mode === 'foreign') await f.write('server-config.json', { instance_origin: 'https://other.example', points: {} });
        if (mode === 'stale') await stale(f);
        quiet(await hook(f, client, event));
        assert.equal(configRequests(f).length, 1);
        const summary = await f.read('server-config.json');
        assert.equal(summary.instance_origin, f.url); assert.ok(summary.points);
        const raw = await readFile(join(f.home, '.hmp/server-config.json'), 'utf8');
        assert.ok(!raw.includes('SYNTHETIC_'));
        assert.equal((await stat(join(f.home, '.hmp/server-config.json'))).mode & 0o777, 0o600);
        assert.equal((await f.names(event === 'Stop' ? 'turns' : 'sessions')).length, 1);
        quiet(await hook(f, client, event === 'Stop' ? 'UserPromptSubmit' : 'Stop'));
        assert.equal(configRequests(f).length, 1);
        assert.equal((await f.names('turns')).length, 1);
      });
    }
  }
  test(`${client} fresh legacy config does not fetch or enable points`, async t => {
    const f = await fixture(t, { remote: { points: {} } });
    await f.write('server-config.json', { instance_origin: f.url });
    quiet(await hook(f, client, 'UserPromptSubmit')); quiet(await hook(f, client, 'Stop'));
    assert.equal(configRequests(f).length, 0);
    assert.equal((await f.names('sessions')).length, 0); assert.equal((await f.names('turns')).length, 0);
  });
  test(`${client} failed refresh keeps cached behavior and retries only after a full hour`, async t => {
    const f = await fixture(t, { fail: true, remote: { points: { backlog: 5 } } });
    await f.write('worker.lock', { pid: process.pid });
    await stale(f, { instance_origin: f.url, points: { backlog: 1 } });
    const before = await f.read('server-config.json');
    const now = Date.now();
    const clock = join(f.home, 'clock.mjs');
    await writeFile(clock, 'Date.now = () => Number(process.env.TEST_NOW);');
    f.env.NODE_OPTIONS += ' --import=' + clock;
    f.env.TEST_NOW = String(now);
    quiet(await hook(f, client, 'UserPromptSubmit'));
    assert.equal(configRequests(f).length, 1);
    assert.deepEqual(await f.read('server-config.json'), before);
    assert.equal((await f.names('spool')).length, 1);
    const attempts = await f.read('server-config-refresh.json');
    assert.deepEqual(attempts, { [f.url]: now });
    f.state.fail = false;
    f.env.TEST_NOW = String(now + hour - 1);
    quiet(await hook(f, client, 'Stop'));
    assert.equal(configRequests(f).length, 1);
    assert.equal((await f.names('turns')).length, 1);
    assert.equal((await f.names('spool')).length, 0);
    f.env.TEST_NOW = String(now + hour);
    quiet(await hook(f, client, 'UserPromptSubmit', { prompt_id: 'later', turn_id: 'later' }));
    assert.equal(configRequests(f).length, 2);
    assert.equal((await f.read('server-config.json')).points.backlog, 5);
  });
}

test('concurrent Claude and Codex hooks share the hourly refresh limit', async t => {
  const f = await fixture(t, { fail: true });
  f.state.delayMs = 100;
  const results = await Promise.all([
    hook(f, 'claude', 'UserPromptSubmit'), hook(f, 'codex', 'Stop'),
  ]);
  results.forEach(quiet);
  assert.equal(configRequests(f).length, 1);
  assert.equal((await f.names('spool')).length, 2);
});

test('config refresh stops at the remaining hook deadline and preserves the event', async t => {
  const f = await fixture(t);
  f.state.hang = true;
  const started = Date.now();
  quiet(await hook(f, 'claude', 'UserPromptSubmit'));
  assert.ok(Date.now() - started < 4000);
  assert.equal(configRequests(f).length, 1);
  assert.equal((await f.names('spool')).length, 1);
  f.state.hang = false;
  quiet(await hook(f, 'codex', 'Stop'));
  assert.equal(configRequests(f).length, 1);
  assert.equal((await f.names('spool')).length, 0);
});
