import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

export const scripts = resolve('plugins/hmp/scripts');
let reportedFallback = false;
export async function fixture(t, { remote = {}, fail = false, noToken = false, claude = '' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hmp-test-'));
  const bin = join(home, 'mock-bin'), project = join(home, 'project');
  await mkdir(bin); await mkdir(project); await mkdir(join(home, '.hmp'), { mode: 0o700 });
  const requests = [], seen = new Set();
  const state = { fail, remote, hang: false, receipt: null, delayMs: 0 };
  const pause = () => new Promise(resolve => setTimeout(resolve, state.delayMs));
  const respond = (method, url, raw) => {
    requests.push({ method, url, body: raw ? JSON.parse(raw) : null });
    if (state.hang) return null;
    if (state.fail) return { status: 503, body: '{}' };
    if (url === '/api/client/forget') return { status: 200, body: JSON.stringify({ forgotten: { captures: 2, facts: 1, blocks: 1 }, retained_notice: 'Synthetic retained notice' }) };
    if (url === '/api/client/config') return { status: 200, body: JSON.stringify(state.remote) };
    let accepted = 0, duplicates = 0;
    for (const event of JSON.parse(raw).events) {
      if (seen.has(event.client_event_id)) duplicates++; else { seen.add(event.client_event_id); accepted++; }
    }
    return { status: 200, body: JSON.stringify(state.receipt ?? { accepted, duplicates, rejected: [] }) };
  };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    await pause();
    const result = respond(req.method, req.url, raw);
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
  const security = noToken ? 'process.exit(1);' : "process.stdout.write(['synthetic','test','credential'].join('-'));";
  await writeFile(join(bin, 'security'), `#!${process.execPath}\n${security}\n`, { mode: 0o700 });
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('2.1.309 (mock)');process.exit(0);}\n${claude || 'process.exit(0);'}\n`, { mode: 0o700 });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    HMP_CLIENT_TOKEN: noToken ? '' : ['synthetic', 'test', 'credential'].join('-'),
    ...(ipc ? { NODE_OPTIONS: `--import=${resolve('test/ipc-fetch.mjs')}` } : {}) };
  const run = (file, args = [], input = '', options = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(scripts, file), ...args], { cwd: project, env, ...options, stdio: ['pipe', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    if (ipc) child.on('message', async message => {
      if (message.type !== 'test_http') return;
      await pause();
      const result = respond(message.method, new URL(message.url).pathname, message.body);
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
  return { home, bin, project, env, requests, seen, state, url, run, hook, names,
    read: async file => JSON.parse(await readFile(join(home, '.hmp', file), 'utf8')),
    write: async (file, data) => { await mkdir(join(home, '.hmp', file, '..'), { recursive: true, mode: 0o700 }); await writeFile(join(home, '.hmp', file), JSON.stringify(data), { mode: 0o600 }); } };
}
