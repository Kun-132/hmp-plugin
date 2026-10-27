import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export const scripts = resolve('plugins/hmp/scripts');
export const workerInit = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'hmp', status: 'connected' }],
  tools: ['mcp__hmp__claim_extraction', 'mcp__hmp__submit_extraction', 'mcp__hmp__submit_purpose_links', 'mcp__hmp__claim_line_job', 'mcp__hmp__submit_line_blocks'] };
export const extractionWorkerInit = { ...workerInit, tools: workerInit.tools.slice(0, 3) };
export const workerSuccess = { type: 'result', subtype: 'success', is_error: false, result: 'OK' };
export const successfulClaude = `process.stdout.write(${JSON.stringify(JSON.stringify(workerInit) + '\n' + JSON.stringify(workerSuccess) + '\n')});`;
let reportedFallback = false;
export async function fixture(t, { remote = {}, fail = false, noToken = false, claude = '' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hmp-test-'));
  const bin = join(home, 'mock-bin'), project = join(home, 'project');
  await mkdir(bin); await mkdir(project); await mkdir(join(home, '.hmp'), { mode: 0o700 });
  const requests = [], seen = new Set();
  const state = { fail, remote, hang: false, receipt: null, delayMs: 0, pointsFail: false, pointsReceipt: { status: 'accepted', written: 1, dropped: {} } };
  const pause = () => new Promise(resolve => setTimeout(resolve, state.delayMs));
  const respond = (method, url, raw, headers = {}) => {
    requests.push({ method, url, body: raw ? JSON.parse(raw) : null, authorization: headers.Authorization ?? headers.authorization ?? null });
    if (state.hang) return null;
    if (state.fail) return { status: 503, body: '{}' };
    if (url === '/api/client/forget') return { status: 200, body: JSON.stringify({ forgotten: { captures: 2, facts: 1, blocks: 1 }, retained_notice: 'Synthetic retained notice' }) };
    if (url === '/api/client/config') return { status: 200, body: JSON.stringify(state.remote) };
    if (url === '/api/client/events' && state.eventsPaused) return { status: 503, body: JSON.stringify({ error: 'client_source_paused' }) };
    if (url === '/api/client/points') return { status: state.pointsFail ? 503 : 200, body: JSON.stringify(state.pointsReceipt) };
    let accepted = 0, duplicates = 0;
    for (const event of JSON.parse(raw).events) {
      if (seen.has(event.client_event_id)) duplicates++; else { seen.add(event.client_event_id); accepted++; }
    }
    return { status: 200, body: JSON.stringify(state.receipt ?? { accepted, duplicates, rejected: [], captures: JSON.parse(raw).events.map(e => ({ client_event_id: e.client_event_id, capture_id: 'cap_' + e.client_event_id.slice(4) })) }) };
  };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    await pause();
    const result = respond(req.method, req.url, raw, req.headers);
    if (result) { res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(result.body); }
  });
  t.after(async () => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  let ipc = process.env.HMP_TEST_TRANSPORT === 'ipc';
  if (!ipc) {
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      ipc = true;
      if (!reportedFallback) {
        t.diagnostic(`Loopback listen denied (${error.code}); using test-only IPC transport.`);
        reportedFallback = true;
      }
    }
  }
  const url = `http://127.0.0.1:${ipc ? 12345 : server.address().port}`;
  await writeFile(join(home, '.hmp/config.json'), JSON.stringify({ instance_url: url, device: 'synthetic-device' }), { mode: 0o600 });
  await writeFile(join(home, '.hmp/mcp.json'), JSON.stringify({ mcpServers: { hmp: { type: 'http', url: url + '/mcp' } } }), { mode: 0o600 });
  const account = 'synthetic-device@127.0.0.1';
  await mkdir(join(home, '.hmp/credential-origins'), { mode: 0o700 });
  await writeFile(join(home, '.hmp/credential-origins', createHash('sha256').update(account).digest('hex') + '.json'),
    JSON.stringify({ account, origin: url }), { mode: 0o600 });
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const setCredentials = async entries => {
    await writeFile(join(home, 'mock-keychain.json'), JSON.stringify(entries), { mode: 0o600 });
    await writeFile(join(bin, 'security'), `#!/bin/sh
account=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-a' ]; then shift; account="$1"; fi
  shift
done
case "$account" in
${Object.entries(entries).map(([key, token]) => `${quote(key)}) printf '%s' ${quote(token)} ;;`).join('\n')}
*) exit 1 ;;
esac
`, { mode: 0o700 });
  };
  await setCredentials(noToken ? {} : { [account]: 'synthetic-test-credential' });
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('2.1.309 (mock)');process.exit(0);}\n${claude || successfulClaude}\n`, { mode: 0o700 });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    HMP_CLIENT_TOKEN: noToken ? '' : ['synthetic', 'test', 'credential'].join('-'), HMP_CLIENT_ORIGIN: url,
    NODE_OPTIONS: `--import=${resolve('test/security-exec.mjs')} ${ipc ? `--import=${resolve('test/ipc-fetch.mjs')}` : ''}` };
  const run = (file, args = [], input = '', options = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(scripts, file), ...args], { cwd: project, env, ...options, stdio: ['pipe', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    if (ipc) child.on('message', async message => {
      if (message.type !== 'test_http') return;
      await pause();
      const result = respond(message.method, new URL(message.url).pathname, message.body, message.headers);
      if (result && child.connected) child.send({ id: message.id, ...result });
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('test_child_timeout')); }, 8000);
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    if (Array.isArray(input)) {
      (async () => {
        for (const chunk of input) {
          child.stdin.write(chunk);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        child.stdin.end();
      })().catch(reject);
    } else child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
  const hook = (event, input = {}) => run('hook.mjs', [event], { cwd: project, session_id: 'synthetic-session', prompt_id: 'synthetic-turn',
    prompt: '合成の質問', last_assistant_message: '合成の最終回答', ...input });
  const names = async dir => readdir(join(home, '.hmp', dir)).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  return { home, bin, project, env, requests, seen, state, url, run, hook, names, setCredentials,
    read: async file => JSON.parse(await readFile(join(home, '.hmp', file), 'utf8')),
    write: async (file, data) => { await mkdir(join(home, '.hmp', file, '..'), { recursive: true, mode: 0o700 }); await writeFile(join(home, '.hmp', file), JSON.stringify(data), { mode: 0o600 }); } };
}
