import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCommand, launchSpec, spawnCommand, killTree, permissionPath, canonicalDirectory, insideDirectory, platformEnv } from '../plugins/hmp/scripts/platform.mjs';
import { claudeEnv, claudeArgs, createStreamGuard, EXTRACTION_TOOLS } from '../plugins/hmp/scripts/worker.mjs';

const winEnv = { PATH: 'C:\\Windows\\system32;"C:\\Users\\synthetic\\.claude-launcher"', PATHEXT: '.COM;.EXE;.BAT;.CMD', COMSPEC: 'C:\\Windows\\system32\\cmd.exe' };
const shim = 'C:\\Users\\synthetic\\.claude-launcher\\claude.cmd';

test('POSIX launches keep the bare name, a process group and a group kill', () => {
  assert.equal(resolveCommand('claude', { platform: 'darwin', exists: () => false }), 'claude');
  const calls = [];
  spawnCommand('claude', ['-p'], { cwd: '/tmp/x', env: {} }, { platform: 'linux', run: (...a) => calls.push(a) });
  assert.deepEqual(calls, [['claude', ['-p'], { cwd: '/tmp/x', env: {}, detached: true }]]);
  const kills = [];
  killTree(42, { platform: 'darwin', kill: (...a) => kills.push(a), run: () => assert.fail('taskkill on POSIX') });
  assert.deepEqual(kills, [[-42, 'SIGKILL']]);
  assert.deepEqual(platformEnv({ USERPROFILE: 'x' }, 'darwin'), {});
});

test('Windows resolves a .cmd shim from PATH and PATHEXT and runs it through cmd.exe without a window', () => {
  assert.equal(resolveCommand('claude', { platform: 'win32', env: winEnv, exists: p => p === shim }), shim);
  assert.equal(resolveCommand('claude', { platform: 'win32', env: winEnv, exists: () => false }), null);
  assert.throws(() => launchSpec('claude', [], { platform: 'win32', env: winEnv, exists: () => false }), { code: 'ENOENT' });
  const spec = launchSpec('claude', ['-p', '', '{"a":[]}', 'two words'], { platform: 'win32', env: winEnv, exists: p => p === shim });
  assert.equal(spec.command, winEnv.COMSPEC);
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(spec.args[3], '"C:\\Users\\synthetic\\.claude-launcher\\claude.cmd ^"-p^" ^"^" ^"{\\^"a\\^":^[^]}^" ^"two^ words^""');
  assert.deepEqual(spec.options, { windowsVerbatimArguments: true, windowsHide: true });
  const exe = launchSpec('codex', ['--version'], { platform: 'win32', env: winEnv, exists: p => p.endsWith('codex.exe') });
  assert.deepEqual(exe, { command: 'C:\\Windows\\system32\\codex.exe', args: ['--version'], options: { windowsHide: true } });
  const calls = [];
  spawnCommand('claude', ['-p'], { env: winEnv }, { platform: 'win32', run: (...a) => calls.push(a), exists: p => p === shim });
  assert.equal(calls[0][2].detached, false);
  assert.equal(calls[0][2].windowsHide, true);
});

test('Windows refuses arguments a shim would expand again', () => {
  for (const arg of ['100%', 'a&b', 'a|b', 'a>b', 'x^', 'line\nbreak', 'bang!'])
    assert.throws(() => launchSpec('claude', [arg], { platform: 'win32', env: winEnv, exists: p => p === shim }), { code: 'EINVAL' });
  const settings = claudeArgs('C:\\Users\\synthetic\\AppData\\Local\\Temp\\hmp-worker-a', { platform: 'win32' });
  assert.doesNotThrow(() => launchSpec('claude', settings, { platform: 'win32', env: winEnv, exists: p => p === shim }));
});

test('Windows stops the whole tree with taskkill', () => {
  const calls = [];
  killTree(42, { platform: 'win32', run: (...a) => calls.push(a.slice(0, 3)), kill: () => assert.fail('group kill on Windows') });
  assert.deepEqual(calls, [['taskkill', ['/T', '/F', '/PID', '42'], { windowsHide: true }]]);
  killTree(undefined, { platform: 'win32', run: () => assert.fail('no pid') });
});

test('Windows read fence uses the POSIX permission form and long names', () => {
  const directory = 'C:\\Users\\Synthetic User\\AppData\\Local\\Temp\\hmp-worker-a';
  assert.equal(permissionPath(directory, 'win32'), '/c/Users/Synthetic User/AppData/Local/Temp/hmp-worker-a');
  assert.equal(permissionPath('/tmp/x', 'darwin'), '/tmp/x');
  assert.ok(claudeArgs(directory, { platform: 'win32' }).includes('Read(//c/Users/Synthetic User/AppData/Local/Temp/hmp-worker-a/**)'));
  const long = p => p.replace(/SYNTHE~1/i, 'Synthetic User').replaceAll('/', '\\');
  const realpath = Object.assign(() => assert.fail('JS realpath keeps short names'), { native: long });
  assert.equal(canonicalDirectory('C:\\Users\\SYNTHE~1\\AppData\\Local\\Temp\\hmp-worker-a', { platform: 'win32', realpath }), directory);
  const fs = { realpath, lstat: () => ({ isFile: () => true }) };
  const opts = { platform: 'win32', ...fs };
  assert.equal(insideDirectory(directory, directory + '\\claim.json', opts), true);
  assert.equal(insideDirectory(directory, 'C:\\Users\\SYNTHE~1\\AppData\\Local\\Temp\\hmp-worker-a\\claim.json', opts), true);
  assert.equal(insideDirectory(directory, 'c:/users/synthetic user/appdata/local/temp/hmp-worker-a/claim.json', opts), true);
  assert.equal(insideDirectory(directory, '/c/Users/Synthetic User/AppData/Local/Temp/hmp-worker-a/claim.json', opts), true);
  assert.equal(insideDirectory(directory, directory + '\\..\\other.json', opts), false);
  assert.equal(insideDirectory(directory, directory + '-b\\claim.json', opts), false);
  assert.equal(insideDirectory(directory, 'C:\\Users\\Synthetic User\\.claude\\credentials.json', opts), false);
  assert.equal(insideDirectory(directory, 'claim.json', opts), false);
  const guard = createStreamGuard(directory, EXTRACTION_TOOLS[0], { platform: 'win32', fs });
  const read = file_path => guard({ type: 'assistant', message: { content: [{ type: 'tool_use', id: file_path, name: 'Read', input: { file_path } }] } });
  assert.doesNotThrow(() => read(directory + '\\claim.json'));
  assert.throws(() => read('C:\\Windows\\win.ini'), /forbidden_read/);
});

test('Windows passes the launcher the folders it checks, and POSIX passes the same keys as before', () => {
  const keys = ['TEMP', 'TMP', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC'];
  const env = Object.fromEntries([...keys, 'HMP_CLIENT_TOKEN'].map(key => [key, 'C:\\Users\\YOSHIK~1\\' + key]));
  assert.deepEqual(Object.keys(platformEnv(env, 'win32')).sort(), [...keys].sort());
  assert.equal(platformEnv(env, 'win32').TEMP, env.TEMP);
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    assert.ok(keys.every(key => claudeEnv('win32')[key] === env[key]));
    assert.ok(keys.every(key => !(key in claudeEnv('darwin'))));
    assert.equal('HMP_CLIENT_TOKEN' in claudeEnv('win32'), false);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test('Windows keeps an absolute binary, times out --version with taskkill and sends server instructions by file', async () => {
  assert.equal(resolveCommand('C:\\tools\\claude.cmd', { platform: 'win32', env: winEnv, exists: p => p === 'C:\\tools\\claude.cmd' }), 'C:\\tools\\claude.cmd');
  const kills = [];
  const run = (command, args, options, done) => { kills.push({ command, args, options }); setTimeout(() => done(Object.assign(Error('killed'))), 20); return { pid: 7 }; };
  const { execCommand } = await import('../plugins/hmp/scripts/platform.mjs');
  await assert.rejects(execCommand('claude', ['--version'], { env: winEnv, timeout: 1 }, { platform: 'win32', run, exists: p => p === shim }));
  assert.equal(kills[0].options.timeout, undefined);
  const { structuredArgs } = await import('../plugins/hmp/scripts/structured-output.mjs');
  const args = structuredArgs({ type: 'object' }, 'line 1\nA & B', 'C:\\Temp\\hmp-prompt-a\\system-prompt.txt');
  assert.deepEqual(args.slice(-2), ['--system-prompt-file', 'C:\\Temp\\hmp-prompt-a\\system-prompt.txt']);
  assert.equal(args.includes('line 1\nA & B'), false);
  assert.doesNotThrow(() => launchSpec('claude', args, { platform: 'win32', env: winEnv, exists: p => p === shim }));
  assert.deepEqual(structuredArgs({ type: 'object' }, 'p').slice(-2), ['--system-prompt', 'p']);
});
