import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { makeEvent, hash } from '../plugins/hmp/scripts/events.mjs';
import { loadToken, credentialAccount } from '../plugins/hmp/scripts/config.mjs';

const success = result => { assert.equal(result.code, 0, result.stderr); return result.stdout ? JSON.parse(result.stdout) : null; };
test('unqualified keychain accounts require a previously pinned exact origin', async () => {
  const config = { instance_url: 'https://original.example', device: 'mock-device' };
  let calls = [];
  const run = async (_binary, args) => { calls.push(args); return { stdout: 'synthetic-legacy' }; };
  const lookup = async account => account === config.device ? { origin: config.instance_url } : null;
  assert.equal(await loadToken(config, { platform: 'darwin', run, lookup }), 'synthetic-legacy');
  assert.deepEqual(calls.map(args => args[args.indexOf('-a') + 1]), ['mock-device']);
  for (const instance_url of ['https://other.example', 'https://original.example:8443']) {
    calls = [];
    assert.equal(await loadToken({ ...config, instance_url }, { platform: 'darwin', run, lookup }), null);
    assert.deepEqual(calls, []);
  }
  calls = [];
  assert.equal(await loadToken(config, { platform: 'darwin', run, lookup: async () => null }), null);
  assert.deepEqual(calls, []);
});
test('scoped account names cannot replace the exact origin binding, including port changes', async () => {
  const config = { instance_url: 'https://original.example:8443', device: 'mock-device' };
  assert.equal(credentialAccount(config), 'mock-device@original.example');
  let called = false;
  const token = await loadToken(config, { platform: 'darwin',
    run: async () => { called = true; return { stdout: 'synthetic-old' }; },
    lookup: async () => ({ origin: 'https://original.example' }),
  });
  assert.equal(token, null); assert.equal(called, false);
});
test('setup holds old and unknown-origin spool and never sends the old credential to the new origin', async t => {
  const f = await fixture(t, { fail: true });
  success(await f.hook('UserPromptSubmit', { prompt: 'SYNTHETIC_ORIGINAL_ONLY' }));
  const original = await f.read('spool/' + (await f.names('spool'))[0]);
  assert.equal(original.instance_origin, f.url);
  const legacy = makeEvent({ session_id: 'legacy', prompt_id: 'turn', prompt: 'SYNTHETIC_UNKNOWN_ORIGIN' }, 'prompt');
  await f.write(`spool/${hash(legacy.client_event_id)}.json`, legacy);
  const other = f.url.replace('127.0.0.1', 'localhost');
  const setup = success(await f.run('manage.mjs', ['setup', other, 'synthetic-device']));
  assert.deepEqual(setup.keychain, { service: 'hmp-client', account: 'synthetic-device@localhost' });
  f.state.fail = false; f.requests.length = 0;
  success(await f.hook('SessionStart'));
  const held = success(await f.run('manage.mjs', ['status']));
  assert.equal(held.spool, 2); assert.equal(held.spool_held, 2);
  assert.equal(f.requests.length, 0);
  await f.setCredentials({ 'synthetic-device@127.0.0.1': 'synthetic-test-credential', 'synthetic-device@localhost': 'synthetic-new-credential' });
  f.env.HMP_CLIENT_TOKEN = 'synthetic-new-credential'; f.env.HMP_CLIENT_ORIGIN = other;
  success(await f.hook('SessionStart'));
  assert.deepEqual(f.requests.map(req => req.url), ['/api/client/config']);
  success(await f.hook('UserPromptSubmit', { prompt: 'SYNTHETIC_NEW_ONLY' }));
  const posted = f.requests.filter(req => req.method === 'POST');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.events[0].client_event_id, original.client_event_id);
  assert.equal(posted[0].body.events[0].text, 'SYNTHETIC_NEW_ONLY');
  assert.equal('instance_origin' in posted[0].body.events[0], false);
  assert.ok(f.requests.every(req => req.authorization === 'Bearer synthetic-new-credential'));
  assert.equal((await f.names('spool')).length, 2);
  success(await f.run('manage.mjs', ['setup', f.url, 'synthetic-device']));
  f.env.HMP_CLIENT_TOKEN = 'synthetic-test-credential'; f.env.HMP_CLIENT_ORIGIN = f.url; f.requests.length = 0;
  success(await f.hook('SessionStart'));
  assert.deepEqual(f.requests.filter(req => req.method === 'POST').flatMap(req => req.body.events.map(event => event.text)), ['SYNTHETIC_ORIGINAL_ONLY']);
  assert.equal((await f.names('spool')).length, 1);
  assert.equal(success(await f.run('manage.mjs', ['status'])).spool_held, 1);
});
test('migration pins legacy credentials to the previous origin even when setup changes the URL first', async t => {
  const f = await fixture(t);
  await rm(join(f.home, '.hmp/credential-origins'), { recursive: true });
  await f.setCredentials({ 'synthetic-device': 'synthetic-legacy' });
  f.env.HMP_CLIENT_TOKEN = 'synthetic-legacy';
  const other = f.url.replace('127.0.0.1', 'localhost');
  success(await f.run('manage.mjs', ['setup', other, 'synthetic-device']));
  const bindings = await Promise.all((await f.names('credential-origins')).map(name => f.read('credential-origins/' + name)));
  assert.deepEqual(bindings.find(value => value.account === 'synthetic-device'), { account: 'synthetic-device', origin: f.url });
  success(await f.hook('SessionStart')); assert.equal(f.requests.length, 0);
  success(await f.run('manage.mjs', ['setup', f.url, 'synthetic-device']));
  success(await f.hook('SessionStart'));
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].authorization, 'Bearer synthetic-legacy');
  const migrated = await Promise.all((await f.names('credential-origins')).map(name => f.read('credential-origins/' + name)));
  assert.equal(migrated.find(value => value.account === 'synthetic-device').origin, f.url);
});
test('fresh setup cannot adopt an existing unqualified credential without an old configured origin', async t => {
  const f = await fixture(t);
  for (const file of ['config.json', 'mcp.json', 'credential-origins']) await rm(join(f.home, '.hmp', file), { recursive: true });
  await f.setCredentials({ 'synthetic-device': 'synthetic-unbound' });
  f.env.HMP_CLIENT_ORIGIN = '';
  success(await f.run('manage.mjs', ['setup', f.url, 'synthetic-device']));
  const bindings = await Promise.all((await f.names('credential-origins')).map(name => f.read('credential-origins/' + name)));
  assert.equal(bindings.length, 1); assert.equal(bindings[0].account, 'synthetic-device@127.0.0.1');
  success(await f.hook('SessionStart')); assert.equal(f.requests.length, 0);
});
test('same-host origin changes need a fresh device account; direct config edits fail closed', async t => {
  const f = await fixture(t);
  const changed = new URL(f.url); changed.port = Number(changed.port) === 65535 ? '65534' : String(Number(changed.port) + 1);
  const config = await f.read('config.json');
  const result = await f.run('manage.mjs', ['setup', changed.origin, config.device]);
  assert.equal(result.code, 1); assert.ok(result.stderr.includes('新しい端末名'));
  assert.deepEqual(await f.read('config.json'), config);
  await f.write('config.json', { ...config, instance_url: changed.origin });
  success(await f.hook('SessionStart')); assert.equal(f.requests.length, 0);
  await f.write('config.json', config);
  const fresh = success(await f.run('manage.mjs', ['setup', changed.origin, 'new-device']));
  assert.equal(fresh.keychain.account, 'new-device@127.0.0.1');
  success(await f.hook('SessionStart')); assert.equal(f.requests.length, 0);
});
