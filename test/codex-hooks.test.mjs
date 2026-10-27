import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat, symlink, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fixture } from './helpers.mjs';
import { AUTOMATED_PREFIXES } from '../plugins/hmp/scripts/turns.mjs';
import { hash } from '../plugins/hmp/scripts/events.mjs';

const events = ['UserPromptSubmit', 'Stop', 'SessionStart'];
const quiet = result => assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
const success = result => { assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ''); return JSON.parse(result.stdout); };
const hook = (f, event, input = {}) => f.run('hook.mjs', [event, 'codex'], {
  hook_event_name: event, cwd: f.project, session_id: 'codex-session', turn_id: 'codex-turn',
  ...(event === 'UserPromptSubmit' ? { prompt: '合成の Codex 質問' } : { last_assistant_message: '合成の Codex 回答', stop_hook_active: false }),
  transcript_path: join(f.home, 'never-read.jsonl'), ...input,
});
async function points(f) {
  await f.write('server-config.json', { instance_origin: f.url, points: { automated_prefixes: ['[SYNTHETIC AUTO]'] } });
  await f.write('worker.lock', { pid: process.pid });
}

for (const value of ['1', '']) {
  test(`Codex with CLAUDECODE=${JSON.stringify(value)} skips every event without saving or sending`, async t => {
    const f = await fixture(t); await points(f);
    f.env.CLAUDECODE = value;
    const before = await f.names('.');
    for (const event of events) {
      quiet(await hook(f, event));
      assert.equal(f.requests.length, 0);
      assert.deepEqual(await f.names('.'), before);
      for (const dir of ['spool', 'sent', 'sessions', 'turns']) {
        await assert.rejects(stat(join(f.home, '.hmp', dir)), { code: 'ENOENT' });
      }
    }
  });
}
test('Claude Code entry still sends and records a turn with CLAUDECODE', async t => {
  const f = await fixture(t); await points(f);
  f.env.CLAUDECODE = '1';
  quiet(await f.hook('UserPromptSubmit'));
  quiet(await f.hook('Stop'));
  assert.deepEqual(f.requests.flatMap(r => r.body.events).map(e => [e.kind, e.text]), [
    ['prompt', '合成の質問'], ['response', '合成の最終回答'],
  ]);
  assert.equal((await f.names('turns')).length, 1);
});

test('Codex payload pairs prompt/response by turn_id, sends both and queues a completed turn', async t => {
  const f = await fixture(t); await points(f);
  quiet(await hook(f, 'UserPromptSubmit', { prompt_id: 'ignored' }));
  quiet(await hook(f, 'Stop', { background_tasks: ['ignored'] }));
  const sent = f.requests.flatMap(r => r.body.events);
  assert.deepEqual(sent.map(e => [e.kind, e.text, e.turn]), [
    ['prompt', '合成の Codex 質問', hash('codex-turn')], ['response', '合成の Codex 回答', hash('codex-turn')],
  ]);
  const names = await f.names('turns'); assert.equal(names.length, 1);
  const turn = await f.read('turns/' + names[0]);
  assert.equal(turn.prompt.client_event_id, sent[0].client_event_id);
  assert.equal(turn.response.client_event_id, sent[1].client_event_id);
  assert.equal(turn.session, 'codex-session');
  quiet(await hook(f, 'Stop')); assert.deepEqual(await f.names('turns'), names);
});
test('Codex SessionStart only updates server config, without output, replay or worker startup', async t => {
  const f = await fixture(t, { fail: true, remote: { notice: true, pending: { extraction: 1, lines: 1 } } });
  quiet(await hook(f, 'UserPromptSubmit'));
  f.requests.length = 0; f.state.fail = false;
  quiet(await hook(f, 'SessionStart'));
  assert.deepEqual(f.requests.map(r => r.url), ['/api/client/config']);
  assert.equal((await f.names('spool')).length, 1);
  assert.deepEqual((await f.read('server-config.json')).pending, { extraction: 1, lines: 1 });
  assert.equal((await f.names('.')).includes('worker.lock'), false);
  await f.write('offrecord/codex-session', {});
  quiet(await hook(f, 'SessionStart'));
  f.state.fail = true; quiet(await hook(f, 'SessionStart', { session_id: 'other' }));
});
test('Codex automatic notifications, offrecord, pause and .hmp-ignore use the shared exclusions', async t => {
  const f = await fixture(t); await points(f);
  for (const prefix of [...AUTOMATED_PREFIXES, '[SYNTHETIC AUTO]']) quiet(await hook(f, 'UserPromptSubmit', { prompt: ' \n' + prefix + ' synthetic' }));
  assert.equal(f.requests.length, 0); assert.equal((await f.names('sessions')).length, 0);
  assert.equal((await f.names('spool')).length, 0);
  for (const exclusion of ['offrecord', 'pause', 'ignore']) {
    if (exclusion === 'offrecord') success(await f.run('forget.mjs', ['codex-session']));
    if (exclusion === 'pause') await f.write('pause', { until: new Date(Date.now() + 60_000).toISOString() });
    if (exclusion === 'ignore') await writeFile(join(f.project, '.hmp-ignore'), '');
    for (const event of events) quiet(await hook(f, event));
    assert.equal(f.requests.length, 0); assert.equal((await f.names('turns')).length, 0);
    await rm(join(f.home, '.hmp/offrecord'), { recursive: true, force: true });
    await rm(join(f.home, '.hmp/pause'), { force: true });
  }
});

async function config(f, text) {
  await mkdir(join(f.home, '.codex'), { mode: 0o700 });
  await writeFile(join(f.home, '.codex/hooks.json'), text, { mode: 0o600 });
}
const readConfig = f => readFile(join(f.home, '.codex/hooks.json'), 'utf8');
const manage = (f, action) => f.run('manage.mjs', ['codex-hooks', action]);
const beforeText = '{\n  "otherTool" : {"unicode":"合成", "escaped":"\\u0041", "number":1e2},\n  "hooks" : {\n    "UserPromptSubmit" : [ { "matcher":"*", "hooks":[{"type":"command","command":"other-tool"}] } ],\n    "Stop":[], "OtherEvent" : [{"hooks":[{"type":"command","command":"keep-me"}]}]\n  }\n}\n';
test('install appends three groups losslessly, is idempotent, removes only its groups and records backup/rollback', async t => {
  const f = await fixture(t); await config(f, beforeText);
  assert.deepEqual(success(await manage(f, 'status')), { installed: false });
  const record = success(await manage(f, 'install'));
  assert.equal(record.verified, true); assert.ok(record.restore.includes(' restore ')); assert.ok(record.remove.includes('codex-hooks remove'));
  assert.deepEqual(record.diff[0].hooks.map(({ event, before, after }) => ({ event, before, after })),
    events.map(event => ({ event, before: 0, after: 1 })));
  const installed = await readConfig(f), parsed = JSON.parse(installed);
  const original = JSON.parse(beforeText);
  assert.deepEqual(parsed.otherTool, original.otherTool); assert.deepEqual(parsed.hooks.OtherEvent, original.hooks.OtherEvent);
  assert.ok(installed.includes('"otherTool" : {"unicode":"合成", "escaped":"\\u0041", "number":1e2}'));
  assert.ok(installed.includes('{ "matcher":"*", "hooks":[{"type":"command","command":"other-tool"}] }'));
  for (const event of events) {
    const groups = parsed.hooks[event];
    assert.equal(groups.length, (original.hooks[event]?.length ?? 0) + 1);
    assert.equal(groups.at(-1).hooks[0].command, `node "$HOME/.hmp/bin/codex-hook.mjs" ${event}`);
  }
  assert.deepEqual(success(await manage(f, 'status')), { installed: true });
  success(await manage(f, 'install')); assert.equal(await readConfig(f), installed);
  assert.equal((await f.read(record.backup)).codex_hooks.text, beforeText);
  const id = record.backup.split('/')[1].replace('.json', '');
  assert.equal((await f.read('changes/' + id + '.json')).verified, true);
  for (const [path, mode] of [['.hmp/bin', 0o700], ['.hmp/bin/codex-hook.mjs', 0o600], ['.codex/hooks.json', 0o600], ['.hmp/' + record.backup, 0o600]]) {
    assert.equal((await stat(join(f.home, path))).mode & 0o777, mode);
  }
  success(await manage(f, 'remove')); assert.equal(await readConfig(f), beforeText);
  assert.deepEqual(success(await manage(f, 'status')), { installed: false });
  success(await f.run('manage.mjs', ['restore', id])); assert.equal(await readConfig(f), beforeText);
  assert.ok((await f.names('backups')).length >= 4);
});
test('remove preserves settings added after installation and mixed groups; restore replays exact snapshots', async t => {
  const f = await fixture(t); await config(f, beforeText);
  success(await manage(f, 'install'));
  const parsed = JSON.parse(await readConfig(f));
  parsed.newTool = { value: 'synthetic addition' };
  parsed.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'new-other-command' });
  const updated = JSON.stringify(parsed, null, '\t') + '\n';
  await writeFile(join(f.home, '.codex/hooks.json'), updated);
  const removed = success(await manage(f, 'remove'));
  const result = JSON.parse(await readConfig(f));
  assert.deepEqual(result.newTool, parsed.newTool);
  assert.deepEqual(result.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'new-other-command' }] }]);
  assert.deepEqual(result.hooks.UserPromptSubmit, JSON.parse(beforeText).hooks.UserPromptSubmit);
  assert.ok((await readConfig(f)).includes('"newTool": {\n\t\t"value": "synthetic addition"\n\t}'));
  const id = removed.backup.split('/')[1].replace('.json', '');
  success(await f.run('manage.mjs', ['restore', id])); assert.equal(await readConfig(f), updated);
});
for (const initial of [null, '{}\n', '{ "hooks" : { } }\n', '{"hooks":{"Stop":[]}}']) {
  test(`install/remove round-trips absent or empty settings: ${initial}`, async t => {
    const f = await fixture(t);
    if (initial !== null) await config(f, initial);
    const first = success(await manage(f, 'install'));
    success(await manage(f, 'install')); success(await manage(f, 'remove'));
    if (initial === null) await assert.rejects(readConfig(f), { code: 'ENOENT' });
    else assert.equal(await readConfig(f), initial);
    success(await f.run('manage.mjs', ['restore', first.backup.split('/')[1].replace('.json', '')]));
    if (initial === null) await assert.rejects(readConfig(f), { code: 'ENOENT' });
    else assert.equal(await readConfig(f), initial);
  });
}
test('secret hooks stop install, remove and restore before any backup or write', async t => {
  for (const action of ['install', 'remove', 'restore']) {
    const f = await fixture(t);
    let id;
    if (action !== 'install') {
      const record = success(await manage(f, 'install'));
      id = record.backup.split('/')[1].replace('.json', '');
    } else await config(f, '{}');
    const text = JSON.stringify({ ...JSON.parse(await readConfig(f)), otherTool: { command: 'tool --token=synthetic-private-value' } });
    await writeFile(join(f.home, '.codex/hooks.json'), text);
    const backups = await f.names('backups'), changes = await f.names('changes');
    const saved = await f.read('codex-hooks-state.json').catch(() => null);
    const result = action === 'restore' ? await f.run('manage.mjs', ['restore', id]) : await manage(f, action);
    assert.equal(result.code, 1, action);
    assert.equal(result.stderr.trim(), 'hooks_contain_secret', action);
    assert.equal(await readConfig(f), text);
    assert.deepEqual(await f.names('backups'), backups);
    assert.deepEqual(await f.names('changes'), changes);
    assert.deepEqual(await f.read('codex-hooks-state.json').catch(() => null), saved);
  }
});
test('hook state stores only presence metadata and backups keep the secret-free full text', async t => {
  const f = await fixture(t); await config(f, beforeText);
  const first = success(await manage(f, 'install'));
  const saved = await f.read('codex-hooks-state.json');
  assert.deepEqual(saved, { file_present: true, hooks_present: true, events_present: ['UserPromptSubmit', 'Stop'] });
  assert.equal(JSON.stringify(saved).includes('other-tool'), false);
  assert.equal((await f.read(first.backup)).codex_hooks.text, beforeText);
});

test('manager rejects symlinked settings and malformed hooks without changing them or making backups', async t => {
  for (const mode of ['file-link', 'directory-link', 'invalid', 'duplicate']) {
    const f = await fixture(t);
    if (mode === 'file-link') {
      await mkdir(join(f.home, '.codex')); await writeFile(join(f.home, 'external.json'), beforeText);
      await symlink(join(f.home, 'external.json'), join(f.home, '.codex/hooks.json'));
    } else if (mode === 'directory-link') {
      await mkdir(join(f.home, 'external')); await symlink(join(f.home, 'external'), join(f.home, '.codex'));
    } else await config(f, mode === 'invalid' ? '{"hooks":{"Stop":{}}}' : '{"hooks":{},"hooks":{}}');
    assert.equal((await manage(f, 'install')).code, 1);
    assert.equal((await f.names('backups')).length, 0);
  }
});

async function launcher(f, event = 'UserPromptSubmit') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(f.home, '.hmp/bin/codex-hook.mjs'), event], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end('{"prompt":"synthetic stdin"}');
  });
}
async function installation(f, version = 'v1') {
  const path = join(f.home, '.claude/plugins/cache/hmp-marketplace/hmp', version);
  await mkdir(join(path, 'scripts'), { recursive: true });
  await writeFile(join(path, 'scripts/hook.mjs'), `import { writeFileSync } from 'node:fs';
let text = ''; for await (const chunk of process.stdin) text += chunk;
writeFileSync(process.env.HOME + '/probe.json', JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2), text, claudeCode: process.env.CLAUDECODE ?? null }));`);
  return path;
}
async function registry(f, path) {
  await writeFile(join(f.home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'hmp@hmp-marketplace': [{ installPath: path }], 'other@other': [{ installPath: path }],
  } }));
}
test('stable launcher follows registry updates, forwards stdin and Codex argument, missing installs exit silently', async t => {
  const f = await fixture(t); success(await manage(f, 'install'));
  quiet(await launcher(f));
  for (const version of ['v1', 'v2']) {
    const path = await installation(f, version); await registry(f, path);
    quiet(await launcher(f, 'Stop'));
    assert.deepEqual(JSON.parse(await readFile(join(f.home, 'probe.json'), 'utf8')), {
      version, args: ['Stop', 'codex'], text: '{"prompt":"synthetic stdin"}', claudeCode: null,
    });
  }
  await rm(join(f.home, 'probe.json'));
  await writeFile(join(f.home, '.claude/plugins/installed_plugins.json'), '{"plugins":{"other@other":[]}}');
  quiet(await launcher(f)); await assert.rejects(stat(join(f.home, 'probe.json')), { code: 'ENOENT' });
});
test('stable launcher inherits CLAUDECODE when spawning the installed hook', async t => {
  const f = await fixture(t); success(await manage(f, 'install'));
  await registry(f, await installation(f));
  for (const value of ['1', '']) {
    f.env.CLAUDECODE = value;
    quiet(await launcher(f));
    assert.equal(JSON.parse(await readFile(join(f.home, 'probe.json'), 'utf8')).claudeCode, value);
  }
});
for (const mode of ['outside', 'prefix-sibling', 'directory-link', 'file-link', 'registry-link', 'cache-link', 'missing']) {
  test(`stable launcher refuses ${mode}`, async t => {
    const f = await fixture(t); success(await manage(f, 'install'));
    let path = await installation(f);
    if (mode === 'outside' || mode === 'prefix-sibling') {
      const dest = mode === 'outside' ? join(f.home, 'outside') : join(f.home, '.claude/plugins/cache/hmp-marketplace-extra');
      await mkdir(join(dest, 'scripts'), { recursive: true });
      await writeFile(join(dest, 'scripts/hook.mjs'), await readFile(join(path, 'scripts/hook.mjs'))); path = dest;
    }
    if (mode === 'directory-link') {
      const link = join(f.home, '.claude/plugins/cache/hmp-marketplace/hmp/link'); await symlink(path, link); path = link;
    }
    if (mode === 'file-link') {
      const target = join(path, 'scripts/hook.mjs');
      await rename(target, join(f.home, 'linked-hook.mjs')); await symlink(join(f.home, 'linked-hook.mjs'), target);
    }
    if (mode === 'missing') path += '-missing';
    await registry(f, path);
    if (mode === 'registry-link') {
      const target = join(f.home, '.claude/plugins/installed_plugins.json');
      await rename(target, join(f.home, 'registry.json')); await symlink(join(f.home, 'registry.json'), target);
    }
    if (mode === 'cache-link') {
      const target = join(f.home, '.claude/plugins/cache/hmp-marketplace');
      await rename(target, join(f.home, 'linked-cache')); await symlink(join(f.home, 'linked-cache'), target);
    }
    quiet(await launcher(f)); await assert.rejects(stat(join(f.home, 'probe.json')), { code: 'ENOENT' });
  });
}

test('legacy hook state is reduced to presence metadata before it is backed up again', async t => {
  const f = await fixture(t); await config(f, beforeText);
  await f.write('codex-hooks-state.json', { baseline: beforeText });
  const result = success(await manage(f, 'install'));
  const saved = await f.read('codex-hooks-state.json');
  assert.equal('baseline' in saved, false);
  assert.deepEqual((await f.read(result.backup)).codex_hooks.state, saved);
  success(await manage(f, 'remove')); assert.equal(await readConfig(f), beforeText);
});
