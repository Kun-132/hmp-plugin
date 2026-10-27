import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

const quiet = r => { assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, ''); };
async function setup(t) {
  const f = await fixture(t, { noToken: true });
  await f.write('server-config.json', { instance_origin: f.url, points: {} });
  await f.write('worker.lock', { pid: process.pid });
  return f;
}

test('ninth pending prompt drops only the oldest and records timestamps without refreshing duplicates', async t => {
  const f = await setup(t), started = Date.now();
  for (let i = 1; i <= 8; i++) quiet(await f.hook('UserPromptSubmit', { prompt_id: 'p' + i, prompt: 'P' + i }));
  const file = 'sessions/' + (await f.names('sessions'))[0];
  const before = (await f.read(file)).prompts;
  assert.equal(before.length, 8);
  assert.ok(before.every(p => Number.isFinite(p.recorded_at) && p.recorded_at >= started && p.recorded_at <= Date.now()));
  quiet(await f.hook('UserPromptSubmit', { prompt_id: 'p8', prompt: 'P8' }));
  assert.deepEqual((await f.read(file)).prompts, before);
  quiet(await f.hook('UserPromptSubmit', { prompt_id: 'p9', prompt: 'P9' }));
  const after = (await f.read(file)).prompts;
  assert.deepEqual(after.map(p => p.text), Array.from({ length: 8 }, (_, i) => 'P' + (i + 2)));
  assert.deepEqual(after.slice(0, 7), before.slice(1));
  assert.equal((await f.names('spool')).length, 9);
});

for (const event of ['UserPromptSubmit', 'Stop']) {
  test(`${event} write removes prompts older than 24 hours and keeps recent prompts`, async t => {
    const f = await setup(t);
    quiet(await f.hook('UserPromptSubmit', { prompt_id: 'old', prompt: 'OLD' }));
    quiet(await f.hook('UserPromptSubmit', { prompt_id: 'recent', prompt: 'RECENT' }));
    const file = 'sessions/' + (await f.names('sessions'))[0], state = await f.read(file);
    state.prompts[0].recorded_at = Date.now() - 86400_000 - 1000;
    state.prompts[1].recorded_at = Date.now() - 86400_000 + 60_000;
    await f.write(file, state);
    quiet(await f.hook(event, { prompt_id: 'new', prompt: 'NEW', background_tasks: ['running'] }));
    const after = (await f.read(file)).prompts;
    assert.deepEqual(after.map(p => p.text), event === 'Stop' ? ['RECENT'] : ['RECENT', 'NEW']);
    assert.deepEqual(after[0], state.prompts[1]);
    assert.equal((await f.names('turns')).length, 0);
    assert.equal((await f.names('spool')).length, 3);
  });

  test(`${event} write bounds legacy prompts and timestamps them once`, async t => {
    const f = await setup(t);
    quiet(await f.hook('UserPromptSubmit'));
    const file = 'sessions/' + (await f.names('sessions'))[0], state = await f.read(file);
    state.prompts = Array.from({ length: 9 }, (_, i) => ({ ...state.prompts[0], client_event_id: 'legacy-' + i, text: 'LEGACY' + i }));
    for (const p of state.prompts) delete p.recorded_at;
    await f.write(file, state);
    const started = Date.now();
    quiet(await f.hook(event, { prompt_id: 'new', prompt: 'NEW', background_tasks: ['running'] }));
    const after = (await f.read(file)).prompts;
    assert.equal(after.length, 8);
    assert.deepEqual(after.map(p => p.text), event === 'Stop'
      ? Array.from({ length: 8 }, (_, i) => 'LEGACY' + (i + 1))
      : [...Array.from({ length: 7 }, (_, i) => 'LEGACY' + (i + 2)), 'NEW']);
    assert.ok(after.every(p => Number.isFinite(p.recorded_at) && p.recorded_at >= started && p.recorded_at <= Date.now()));
    quiet(await f.hook('Stop', { background_tasks: ['running'] }));
    assert.deepEqual((await f.read(file)).prompts, after);
  });
}
