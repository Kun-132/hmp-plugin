import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

const success = r => { assert.equal(r.code, 0); assert.equal(r.stderr, ''); return r.stdout ? JSON.parse(r.stdout) : null; };
test('offrecord discards only this session spool and never sends or spools later Hooks', async t => {
  const f = await fixture(t, { fail: true });
  success(await f.hook('UserPromptSubmit'));
  success(await f.hook('UserPromptSubmit', { session_id: 'other-session' }));
  assert.equal((await f.names('spool')).length, 2);
  assert.deepEqual(success(await f.run('forget.mjs', ['synthetic-session'])), { offrecord: true, discarded: 1 });
  const remaining = await f.names('spool'); assert.equal(remaining.length, 1);
  assert.equal((await f.read('spool/' + remaining[0])).session, 'other-session');
  const count = f.requests.length;
  for (const event of ['UserPromptSubmit', 'Stop']) success(await f.hook(event));
  const start = success(await f.hook('SessionStart'));
  assert.equal(start.hookSpecificOutput.additionalContext, 'HMP: このセッションはオフレコ\nHMP: session_id="synthetic-session"');
  assert.equal(f.requests.length, count); assert.deepEqual(await f.names('spool'), remaining);
  assert.equal(success(await f.run('manage.mjs', ['status', 'synthetic-session'])).notice, 'このセッションはオフレコ');
  f.state.fail = false;
  success(await f.hook('SessionStart', { session_id: 'other-session' }));
  assert.ok(f.requests.at(-2).body.events.every(e => e.session === 'other-session'));
});
test('preview is read-only and confirm uses the scoped session API, resume sends future events', async t => {
  const f = await fixture(t);
  success(await f.run('forget.mjs', ['synthetic-session']));
  assert.equal(f.requests.length, 0);
  const preview = success(await f.run('forget.mjs', ['synthetic-session', '--preview']));
  assert.equal(preview.forgotten.captures, 2);
  assert.deepEqual(f.requests[0].body, { client_version: '0.1.2', device: 'synthetic-device', session: 'synthetic-session', scope: 'session', dry_run: true });
  const result = success(await f.run('forget.mjs', ['synthetic-session', '--confirm']));
  assert.equal(f.requests[1].url, '/api/client/forget'); assert.equal('dry_run' in f.requests[1].body, false);
  assert.equal(result.retained_notice, 'Synthetic retained notice');
  success(await f.run('forget.mjs', ['synthetic-session', '--resume']));
  success(await f.hook('UserPromptSubmit', { prompt_id: 'after-resume' }));
  assert.equal(f.requests.at(-1).url, '/api/client/events');
  assert.equal(f.requests.at(-1).body.events[0].session, 'synthetic-session');
});
test('remote failure retains offrecord and session paths cannot escape the marker directory', async t => {
  const f = await fixture(t, { fail: true });
  success(await f.run('forget.mjs', ['../other']));
  assert.ok((await f.names('offrecord')).includes('%2E%2E%2Fother'));
  assert.equal((await f.run('forget.mjs', ['../other', '--confirm'])).code, 1);
  success(await f.hook('UserPromptSubmit', { session_id: '../other' }));
  assert.equal((await f.names('spool')).length, 0);
  assert.equal((await f.run('forget.mjs', ['not-offrecord', '--confirm'])).code, 1);
});
