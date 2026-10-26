import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { claudeArgs, TOOLS } from '../plugins/hmp/scripts/worker.mjs';

const binary = process.argv[2];
if (!binary?.startsWith('/')) throw Error('Pass the absolute Claude executable path.');
const home = await mkdtemp(join(tmpdir(), 'hmp-oauth-probe-'));
const bin = join(home, 'bin');
await mkdir(bin);
await writeFile(join(bin, 'security'), `#!${process.execPath}
const fs = require('node:fs'), p = require('node:path');
let args = process.argv.slice(2);
if (args[0] === '-i') args = fs.readFileSync(0, 'utf8').match(/"[^"]*"|\\S+/g).map(x => x.replace(/^"|"$/g, ''));
const service = args[args.indexOf('-s') + 1];
const file = p.join(process.env.HOME, 'fake-keychain-' + Buffer.from(service || '').toString('hex'));
fs.appendFileSync(p.join(process.env.HOME, 'security-calls'), args[0] + '\\n');
if (args[0] === 'find-generic-password') { try { process.stdout.write(fs.readFileSync(fs.existsSync(file) ? file : p.join(process.env.HOME, 'synthetic-credentials'))); } catch { process.exit(44); } }
else if (args[0] === 'add-generic-password') fs.writeFileSync(file, Buffer.from(args[args.indexOf('-X') + 1], 'hex'), {mode:0o600});
else process.exit(44);
`, { mode: 0o700 });
let origin, phase = '', attempts = [], authorizations = 0, tokens = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: origin + '/mcp', authorization_servers: [origin] });
  if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  if (url.pathname === '/register') return json({ client_id: 'synthetic-client', redirect_uris: JSON.parse(raw).redirect_uris, token_endpoint_auth_method: 'none' });
  if (url.pathname === '/authorize') {
    authorizations++;
    const callback = new URL(url.searchParams.get('redirect_uri'));
    assert.ok(['localhost', '127.0.0.1'].includes(callback.hostname));
    callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', 'synthetic-code');
    res.writeHead(302, { Location: callback.href }); return res.end();
  }
  if (url.pathname === '/token') { tokens++; return json({ access_token: 'synthetic-oauth-access', refresh_token: 'synthetic-oauth-refresh', token_type: 'Bearer', expires_in: 3600 }); }
  if (url.pathname === '/mcp' || url.pathname === '/other') {
    const authorized = req.headers.authorization === 'Bearer synthetic-oauth-access';
    attempts.push({ phase, method: raw ? JSON.parse(raw).method : req.method, authorized });
    if (!authorized) { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }); return res.end(); }
    if (req.method === 'GET') { res.writeHead(405); return res.end(); }
    const rpc = JSON.parse(raw);
    if (!Object.hasOwn(rpc, 'id')) { res.writeHead(202); return res.end(); }
    const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: TOOLS.map(name => ({ name: name.replace('mcp__hmp__', ''), description: 'Synthetic probe', inputSchema: { type: 'object', properties: {} } })) }
      : rpc.method === 'tools/call' ? { content: [{ type: 'text', text: '{"item":null}' }] } : {};
    return json({ jsonrpc: '2.0', id: rpc.id, result });
  }
  if (url.pathname === '/v1/messages') {
    const request = JSON.parse(raw);
    const message = { id: 'msg_synthetic', type: 'message', role: 'assistant', model: request.model, content: [{ type: 'text', text: 'synthetic' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!request.stream) return json(message);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return res.end();
  }
  res.writeHead(404); res.end();
});
try {
  const offline = process.argv.includes('--offline');
  if (!offline) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${offline ? 12345 : server.address().port}`;
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PATH: `${bin}:/usr/bin:/bin`, USER: 'synthetic',
    ANTHROPIC_API_KEY: 'synthetic-api-key', ANTHROPIC_BASE_URL: origin, ENABLE_TOOL_SEARCH: 'false',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  async function run(args, login = false, stopAtInit = false) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', opened = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      const consume = chunk => {
        output += chunk;
        if (stopAtInit && output.includes('"subtype":"init"')) child.kill('SIGKILL');
        const match = output.match(new RegExp(origin + '/authorize[^\\s\\x1b]+'));
        if (login && match && !opened) {
          opened = true;
          fetch(match[0], { signal: AbortSignal.timeout(10000) }).catch(reject);
        }
      };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
      if (!login) child.stdin.end('Synthetic authentication probe only.');
    });
  }
  if (offline) {
    const entry = { type: 'http', url: origin + '/mcp' };
    const key = 'hmp|' + createHash('sha256').update(JSON.stringify({ ...entry, headers: {} })).digest('hex').slice(0, 16);
    await writeFile(join(home, 'synthetic-credentials'), JSON.stringify({ mcpOAuth: { [key]: {
      serverName: 'hmp', serverUrl: entry.url, accessToken: 'synthetic-oauth-access', refreshToken: 'synthetic-oauth-refresh', expiresAt: Date.now() + 3600000,
    } } }), { mode: 0o600 });
    for (const [name, path] of [['hmp', '/mcp'], ['renamed', '/mcp'], ['hmp', '/other']]) {
      await writeFile(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { [name]: { ...entry, url: origin + path } } }), { mode: 0o600 });
      const debug = join(home, 'debug.log');
      await rm(debug, { force: true });
      const args = claudeArgs(home);
      args[args.indexOf('--mcp-config') + 1] = join(home, 'mcp.json');
      const result = await run([...args, '--debug-file', debug], false, true);
      assert.ok(result.output.includes('"subtype":"init"'));
      const lines = (await readFile(debug, 'utf8')).split('\n').filter(line => /MCP server.*(Returning tokens|Has refresh token|Connection failed)/.test(line));
      const returned = lines.some(line => line.includes('Returning tokens'));
      assert.equal(returned, name === 'hmp' && path === '/mcp');
      process.stdout.write(JSON.stringify({ offline: true, name, path, tokens_returned: returned, debug: lines }) + '\n');
    }
  } else {
    assert.equal((await run(['mcp', 'add', '--transport', 'http', '--scope', 'user', 'hmp', origin + '/mcp'])).code, 0);
    phase = 'login';
    const login = await run(['mcp', 'login', 'hmp', '--no-browser'], true);
    process.stdout.write(JSON.stringify({ phase, code: login.code, authorizations, tokens, output: login.output }) + '\n');
    assert.equal(login.code, 0);
    for (const [name, path] of [['hmp', '/mcp'], ['renamed', '/mcp'], ['hmp', '/other']]) {
      phase = name + path;
      const config = join(home, 'mcp.json');
      await writeFile(config, JSON.stringify({ mcpServers: { [name]: { type: 'http', url: origin + path } } }), { mode: 0o600 });
      const args = claudeArgs(home);
      args[args.indexOf('--mcp-config') + 1] = config;
      const result = await run(args);
      assert.equal(result.code, 0, result.output);
      process.stdout.write(JSON.stringify({ phase, code: result.code, attempts: attempts.filter(x => x.phase === phase) }) + '\n');
    }
    assert.ok(attempts.some(x => x.phase === 'hmp/mcp' && x.method === 'tools/list' && x.authorized));
    assert.ok(!attempts.some(x => x.phase !== 'login' && x.phase !== 'hmp/mcp' && x.authorized));
    process.stdout.write(JSON.stringify({ passed: true, fake_security_calls: (await readFile(join(home, 'security-calls'), 'utf8')).trim().split('\n').length }) + '\n');
  }
} finally {
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
