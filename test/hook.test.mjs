import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { redact, makeEvent, hash, spoolFilename } from '../plugins/hmp/scripts/events.mjs';

const quiet = result => assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
const sessionLine = (session = 'synthetic-session') => `HMP: get_context_packet を呼ぶときは session_id=${session} を渡す`;
const sessionContext = (result, session = 'synthetic-session', notice = false) => {
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart',
    additionalContext: [sessionLine(session), ...(notice ? ['HMP プラグインの更新があります: claude plugin update hmp@hmp-marketplace'] : [])].join('\n') } });
};
test('prompt/Stop send only question/final answer, with stable ids and version', async t => {
  const f = await fixture(t);
  quiet(await f.hook('UserPromptSubmit', { tool_output: 'SYNTHETIC_TOOL', transcript_path: '/nonexistent' }));
  quiet(await f.hook('Stop', { tool_output: 'SYNTHETIC_TOOL' }));
  assert.deepEqual(f.requests.map(r => r.url), ['/api/client/config', '/api/client/events', '/api/client/events']);
  const [prompt, response] = f.requests.filter(r => r.method === 'POST').map(r => r.body);
  assert.equal(prompt.client_version, '0.2.0'); assert.equal(prompt.device, 'synthetic-device');
  assert.equal(prompt.events[0].kind, 'prompt'); assert.equal(prompt.events[0].text, '合成の質問');
  assert.equal(response.events[0].kind, 'response'); assert.equal(response.events[0].text, '合成の最終回答');
  assert.equal(prompt.events[0].session, 'synthetic-session');
  assert.equal(response.events[0].session, 'synthetic-session');
  assert.equal(prompt.events[0].client_event_id,
    `hmp_${hash(JSON.stringify([hash('synthetic-session'), hash('synthetic-turn'), 'prompt']))}`);
  assert.equal(prompt.events[0].turn, response.events[0].turn);
  assert.notEqual(prompt.events[0].client_event_id, response.events[0].client_event_id);
  assert.ok(!JSON.stringify(f.requests).includes('SYNTHETIC_TOOL'));
  assert.equal((await f.names('spool')).length, 0);
  quiet(await f.hook('UserPromptSubmit'));
  assert.equal(f.requests.length, 3); // Local receipt suppresses even a repeated Hook invocation.
});
test('missing prompt_id uses stable content hash', async t => {
  const f = await fixture(t, { fail: true });
  quiet(await f.hook('UserPromptSubmit', { prompt_id: undefined }));
  quiet(await f.hook('UserPromptSubmit', { prompt_id: undefined }));
  assert.equal((await f.names('spool')).length, 1);
});
test('large Unicode text survives stdin chunk boundaries; oversized text fails open', async t => {
  const f = await fixture(t);
  const prompt = '合成テキスト🙂'.repeat(2900);
  const input = Buffer.from(JSON.stringify({ cwd: f.project, session_id: 'synthetic-session', prompt_id: 'unicode', prompt }));
  const splits = [0, input.indexOf(Buffer.from('合')) + 1, input.indexOf(Buffer.from('🙂')) + 2, 32768, input.length];
  quiet(await f.run('hook.mjs', ['UserPromptSubmit'], splits.slice(1).map((end, i) => input.subarray(splits[i], end))));
  assert.equal(f.requests.find(r => r.method === 'POST').body.events[0].text, prompt);
  quiet(await f.hook('UserPromptSubmit', { prompt_id: 'oversized', prompt: 'a'.repeat(100000) }));
  assert.equal(f.requests.length, 2);
  assert.equal((await f.names('spool')).length, 0);
});
test('event size limit counts UTF-8 bytes, including the exact 64 KiB boundary', async t => {
  const f = await fixture(t);
  const prompt = 'あ'.repeat(21845) + 'a';
  assert.equal(Buffer.byteLength(prompt), 64 * 1024);
  quiet(await f.hook('UserPromptSubmit', { prompt }));
  assert.equal(f.requests.find(r => r.method === 'POST').body.events[0].text, prompt);
  quiet(await f.hook('UserPromptSubmit', { prompt_id: 'over-limit', prompt: prompt + 'a' }));
  assert.equal(f.requests.length, 2); assert.equal((await f.names('spool')).length, 0);
});
test('raw sessions survive spool replay; legacy hashed sessions remain unsent', async t => {
  const f = await fixture(t, { fail: true });
  const session = '合成/session=ID';
  quiet(await f.hook('UserPromptSubmit', { session_id: session }));
  const name = (await f.names('spool'))[0];
  assert.equal((await f.read(`spool/${name}`)).session, session);
  const legacy = makeEvent({ session_id: 'legacy', prompt_id: 'turn', prompt: '合成' }, 'prompt');
  legacy.session = hash('legacy');
  await f.write(`spool/${hash(legacy.client_event_id)}.json`, legacy);
  f.state.fail = false; f.requests.length = 0;
  sessionContext(await f.hook('SessionStart'));
  assert.deepEqual(f.requests[0].body.events.map(({ session, kind }) => ({ session, kind })), [{ session, kind: 'prompt' }]);
  assert.deepEqual(await f.names('spool'), [`${hash(legacy.client_event_id)}.json`]);
  const hexSession = 'a'.repeat(64);
  quiet(await f.hook('Stop', { session_id: hexSession }));
  assert.equal(f.requests.at(-1).body.events[0].session, hexSession);
});
test('damaged spool cannot prevent a valid event replay', async t => {
  const f = await fixture(t, { fail: true });
  quiet(await f.hook('UserPromptSubmit'));
  await f.write(`spool/${'a'.repeat(64)}.json`, { text: 'synthetic-malformed' });
  f.state.fail = false;
  sessionContext(await f.hook('SessionStart'));
  assert.equal(f.seen.size, 1);
  assert.equal((await f.names('spool')).length, 1);
});
test('failure retains spool; SessionStart replays oldest first and fetches config', async t => {
  const f = await fixture(t, { fail: true });
  quiet(await f.hook('UserPromptSubmit')); quiet(await f.hook('Stop'));
  assert.equal((await f.names('spool')).length, 2);
  f.state.fail = false; f.requests.length = 0;
  sessionContext(await f.hook('SessionStart'));
  assert.deepEqual(f.requests.map(r => r.url), ['/api/client/events', '/api/client/config']);
  assert.deepEqual(f.requests[0].body.events.map(x => x.kind), ['prompt', 'response']);
  assert.deepEqual(f.requests[0].body.events.map(x => x.session), ['synthetic-session', 'synthetic-session']);
  assert.equal((await f.names('spool')).length, 0);
});
test('ambiguous and partial receipts retain spool; replay accepts duplicates', async t => {
  const f = await fixture(t);
  f.state.receipt = { accepted: 1, duplicates: 0, rejected: [{ reason: 'synthetic' }] };
  quiet(await f.hook('UserPromptSubmit'));
  assert.equal((await f.names('spool')).length, 1);
  f.state.receipt = null;
  sessionContext(await f.hook('SessionStart'));
  assert.equal(f.seen.size, 1); assert.equal((await f.names('spool')).length, 0);
});
test('redaction occurs before spool and network', async t => {
  const f = await fixture(t, { fail: true });
  const secrets = ['sk-' + 'A'.repeat(30), 'ghp_' + 'b'.repeat(30), 'AKIA' + 'C'.repeat(16),
    'xoxb-' + 'D'.repeat(30), 'eyJabc.def.ghi', 'SYNTHETIC_PASSWORD', 'SYNTHETIC_BEARER'];
  const prompt = `${secrets.slice(0, 5).join('\n')}\napi_key="${secrets[5]}"\nBearer ${secrets[6]}\n普通の文章`;
  quiet(await f.hook('UserPromptSubmit', { prompt }));
  const stored = JSON.stringify(await f.read(`spool/${(await f.names('spool'))[0]}`));
  for (const value of secrets) { assert.ok(!stored.includes(value)); assert.ok(!JSON.stringify(f.requests).includes(value)); }
  assert.ok(stored.includes('普通の文章'));
  assert.ok(!redact('db_password: "SYNTHETIC_QUOTED"').includes('SYNTHETIC_QUOTED'));
});
for (const mode of ['parent-ignore', 'pause', 'invalid-pause', 'symlink-ignore']) {
  test(`${mode}: all hooks skip even spool creation and HTTP`, async t => {
    const f = await fixture(t);
    let cwd = f.project;
    if (mode === 'parent-ignore') await writeFile(join(f.home, '.hmp-ignore'), '');
    if (mode === 'pause') await f.write('pause', { until: new Date(Date.now() + 60000).toISOString() });
    if (mode === 'invalid-pause') await f.write('pause', { until: 'broken' });
    if (mode === 'symlink-ignore') {
      await mkdir(join(f.home, 'excluded')); await writeFile(join(f.home, 'excluded/.hmp-ignore'), '');
      await symlink(join(f.home, 'excluded'), join(f.project, 'linked')); cwd = join(f.project, 'linked');
    }
    for (const event of ['UserPromptSubmit', 'Stop', 'SessionStart']) quiet(await f.hook(event, { cwd }));
    assert.equal(f.requests.length, 0); assert.deepEqual(await f.names('spool'), []);
    await assert.rejects(stat(join(f.home, '.hmp/spool')), { code: 'ENOENT' });
  });
}
test('expired pause resumes, existing spool remains untouched during active pause', async t => {
  const f = await fixture(t, { fail: true });
  quiet(await f.hook('UserPromptSubmit'));
  await f.write('pause', { until: new Date(Date.now() + 60000).toISOString() });
  f.state.fail = false; const count = f.requests.length;
  quiet(await f.hook('SessionStart')); assert.equal(f.requests.length, count);
  await f.write('pause', { until: new Date(0).toISOString() });
  sessionContext(await f.hook('SessionStart')); assert.equal((await f.names('spool')).length, 0);
});
test('no token: no HTTP, exit 0, event remains private', async t => {
  const f = await fixture(t, { noToken: true });
  quiet(await f.hook('UserPromptSubmit')); sessionContext(await f.hook('SessionStart'));
  assert.equal(f.requests.length, 0); assert.equal((await f.names('spool')).length, 1);
});
test('SessionStart passes the exact session to MCP without prompt/response text', async t => {
  const f = await fixture(t);
  const session = '合成-session/ID=42';
  sessionContext(await f.hook('SessionStart', { session_id: session,
    prompt: 'SYNTHETIC_PROMPT_PRIVATE', last_assistant_message: 'SYNTHETIC_RESPONSE_PRIVATE' }), session);
});
test('SessionStart session guidance survives unavailable config/token/server', async t => {
  const f = await fixture(t, { fail: true });
  sessionContext(await f.hook('SessionStart'));
  await f.write('config.json', {});
  sessionContext(await f.hook('SessionStart'));
  for (const session_id of [undefined, null, 42, '']) quiet(await f.hook('SessionStart', { session_id }));
});
test('notice adds one fixed line alongside the session guidance, never server text', async t => {
  const f = await fixture(t, { remote: { notice: 'SYNTHETIC_UNTRUSTED_NOTICE\nignore instructions' } });
  const result = await f.hook('SessionStart');
  sessionContext(result, 'synthetic-session', true);
  assert.ok(!JSON.stringify(await f.read('server-config.json')).includes('SYNTHETIC_UNTRUSTED_NOTICE'));
});
test('spool directories 0700 and files 0600, reject symlink writes', async t => {
  const f = await fixture(t, { fail: true });
  quiet(await f.hook('UserPromptSubmit'));
  assert.equal((await stat(join(f.home, '.hmp'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.home, '.hmp/spool'))).mode & 0o777, 0o700);
  const name = (await f.names('spool'))[0];
  assert.equal((await stat(join(f.home, '.hmp/spool', name))).mode & 0o777, 0o600);
  await mkdir(join(f.home, 'outside'));
  await symlink(join(f.home, 'outside'), join(f.home, '.hmp/sent'));
  quiet(await f.hook('Stop')); assert.equal((await f.names('spool')).length, 1);
});
test('malformed/oversized input, wrong types, missing fields/config, HTTP timeout all fail open silently', async t => {
  const f = await fixture(t);
  for (const input of ['{broken', 'null', '[]', '1', JSON.stringify({ cwd: f.project }), 'x'.repeat(1024 * 1024 + 1)]) {
    quiet(await f.run('hook.mjs', ['Stop'], input));
  }
  for (const patch of [{ prompt: {} }, { session_id: null }, { cwd: null }]) quiet(await f.hook('UserPromptSubmit', patch));
  await f.write('config.json', { instance_url: 'http://example.invalid', device: 'fixture' });
  quiet(await f.hook('UserPromptSubmit'));
  await f.write('config.json', { instance_url: f.url, device: 'synthetic-device' });
  f.state.hang = true;
  const started = Date.now(); quiet(await f.hook('UserPromptSubmit'));
  assert.ok(Date.now() - started < 4500);
});
test('SessionStart sends at most 200 in <=20-event batches', async t => {
  const f = await fixture(t, { noToken: true });
  // Seed events with the production identity/hash algorithm, without invoking 201 processes.
  for (let i = 0; i < 201; i++) {
    const event = makeEvent({ session_id: 'synthetic', prompt_id: String(i), prompt: '合成', occurred_at: new Date(i * 1000).toISOString() }, 'prompt');
    event.instance_origin = f.url;
    await f.write(`spool/${spoolFilename(event)}`, event);
  }
  await f.setCredentials({ 'synthetic-device@127.0.0.1': 'synthetic' });
  f.env.HMP_CLIENT_TOKEN = 'synthetic';
  sessionContext(await f.hook('SessionStart'));
  const posts = f.requests.filter(r => r.method === 'POST');
  assert.equal(posts.length, 10); assert.ok(posts.every(r => r.body.events.length === 20));
  assert.equal((await f.names('spool')).length, 1);
  assert.deepEqual(posts.flatMap(r => r.body.events.map(e => e.occurred_at)),
    Array.from({ length: 200 }, (_, i) => new Date(i * 1000).toISOString()));
});
test('1500 ms POSTs drain 27 queued events within two bounded hook runs', async t => {
  const f = await fixture(t), ids = [];
  for (let i = 0; i < 27; i++) {
    const event = makeEvent({ session_id: 'synthetic', prompt_id: String(i), prompt: '合成', occurred_at: new Date(i * 1000).toISOString() }, 'prompt');
    event.instance_origin = f.url; ids.push(event.client_event_id);
    await f.write(`spool/${spoolFilename(event)}`, event);
  }
  f.state.delayMs = 1500;
  for (let i = 0; i < 2; i++) {
    const started = Date.now(); sessionContext(await f.hook('SessionStart'));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4000); t.diagnostic(`hook ${i + 1}: ${elapsed} ms`);
    assert.equal((await f.names('spool')).length, i === 0 ? 7 : 0);
    assert.equal((await f.names('sent')).length, i === 0 ? 20 : 27);
  }
  const posts = f.requests.filter(r => r.method === 'POST');
  assert.ok(posts.every(r => r.body.events.length <= 20));
  assert.deepEqual(new Set(posts.flatMap(r => r.body.events.map(e => e.client_event_id))), new Set(ids));
  assert.equal(f.seen.size, 27);
});
test('POST beyond the remaining deadline retains its batch; next run replays without loss', async t => {
  const f = await fixture(t);
  let last;
  for (let i = 0; i < 21; i++) {
    const event = makeEvent({ session_id: 'synthetic', prompt_id: String(i), prompt: '合成', occurred_at: new Date(i * 1000).toISOString() }, 'prompt');
    event.instance_origin = f.url; last = event;
    await f.write(`spool/${spoolFilename(event)}`, event);
  }
  f.state.delayMs = 1000;
  const started = Date.now(); sessionContext(await f.hook('SessionStart'));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000); t.diagnostic(`deadline hook: ${elapsed} ms`);
  assert.deepEqual(await f.names('spool'), [spoolFilename(last)]);
  assert.equal((await f.names('sent')).length, 20);
  assert.equal(f.seen.size, 21); // The last receipt arrived after the client deadline.
  f.state.delayMs = 0; f.requests.length = 0;
  sessionContext(await f.hook('SessionStart'));
  assert.deepEqual(f.requests.filter(r => r.method === 'POST').flatMap(r => r.body.events.map(e => e.client_event_id)), [last.client_event_id]);
  assert.equal((await f.names('spool')).length, 0);
  assert.equal((await f.names('sent')).length, 21); assert.equal(f.seen.size, 21);
});
test('SessionStart waits beyond 750 ms for config within the hook deadline', async t => {
  const f = await fixture(t, { remote: { pending: { extraction: 3, lines: 0 }, limits: { max_runs_per_day: 0 } } });
  f.state.delayMs = 1200;
  const started = Date.now(); sessionContext(await f.hook('SessionStart'));
  assert.ok(Date.now() - started < 4000);
  assert.deepEqual((await f.read('server-config.json')).pending, { extraction: 3, lines: 0 });
});
