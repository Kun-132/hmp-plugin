import { lineSplitter } from './stream-lines.mjs';
import { spawnCommand, killTree } from './platform.mjs';
import { pathFor, readJSON, writeJSON } from './state.mjs';
import { realpathSync } from 'node:fs';
import { mkdtemp, chmod, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexExecArgs, codexEnv, codexUsage, ensureCodexState } from './codex-exec.mjs';
import { runClaude, MCP_SYSTEM_PROMPT, VERIFY_PROMPT, mcpPrompt } from './worker.mjs';

export function mcpCodexArgs(config, stageTools, directory) {
  return codexExecArgs(directory, { mcpConfig: [
    `mcp_servers.hmp.url=${JSON.stringify(config.instance_url + '/mcp')}`,
    `mcp_servers.hmp.enabled_tools=${JSON.stringify(stageTools.map(tool => tool.replace(/^mcp__hmp__/, '')))}`,
    'mcp_servers.hmp.required=true',
  ] });
}
export async function runMcpCodex(config, stageTools, timeoutMs, { binary = 'codex', tempRoot = tmpdir(), verify = false } = {}) {
  const started = Date.now();
  const failed = reason => ({ status: 'failed', reason, lines: false, submits: 0 });
  let directory;
  try {
    directory = await mkdtemp(join(tempRoot, 'hmp-mcp-codex-'));
    directory = realpathSync(directory);
    await chmod(directory, 0o700);
    await ensureCodexState();
    return await new Promise(resolve => {
      let child;
      const previousMask = process.umask(0o077);
      try {
        child = spawnCommand(binary, mcpCodexArgs(config, stageTools, directory), {
          cwd: directory, env: { ...codexEnv(), TMPDIR: directory }, stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch { resolve(failed('spawn_failed')); return; }
      finally { process.umask(previousMask); }
      const [claim, submit] = stageTools.map(tool => tool.replace(/^mcp__hmp__/, ''));
      const calls = new Map();
      let bytes = 0, reason, claims = 0, submits = 0, completed = false, usage = {};
      const stop = code => {
        reason ??= code;
        killTree(child.pid);
      };
      const consume = line => {
        if (!line.trim() || reason) return;
        try {
          const event = JSON.parse(line);
          if (event.type === 'turn.failed' || event.type === 'error') { stop('result_failed'); return; }
          if (['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
            const item = event.item;
            if (verify && !['agent_message', 'reasoning', 'error'].includes(item?.type)) {
              stop('verification_tool_call'); return;
            }
            if (!['agent_message', 'reasoning', 'error', 'mcp_tool_call'].includes(item?.type)) { stop('forbidden_tool'); return; }
            if (item.type === 'mcp_tool_call') {
              if (item.server !== 'hmp' || ![claim, submit].includes(item.tool)) { stop('forbidden_tool'); return; }
              if (typeof item.id !== 'string' || !item.id || calls.has(item.id) && calls.get(item.id) !== item.tool) {
                stop('invalid_tool_id'); return;
              }
              if (!calls.has(item.id)) {
                calls.set(item.id, item.tool);
                if (item.tool === claim && ++claims > 1) { stop('claim_limit'); return; }
                if (item.tool === submit && ++submits > 3) { stop('submit_limit'); return; }
              }
            }
          }
          if (event.type === 'turn.completed') {
            completed = true;
            usage = { ...usage, ...codexUsage(event) };
          }
        } catch { stop('stream_invalid'); }
      };
      const interrupt = () => stop('interrupted');
      const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs));
      process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
      child.on('error', () => stop('spawn_failed'));
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      const split = lineSplitter(value => consume(value), () => Boolean(reason));
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16 * 1024 * 1024) { split.clear(); stop('output_limit'); return; }
        if (reason) return;
        split.write(chunk);
      });
      child.on('close', code => {
        consume(split.rest()); clearTimeout(timer);
        process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
        reason ??= code !== 0 ? 'exit_failed' : !completed ? 'result_missing' : !verify && claims === 0 ? 'tools_missing' : undefined;
        resolve({ status: reason === 'tools_missing' ? 'stage_unavailable' : reason ? 'failed' : 'ok',
          ...(reason ? { reason } : {}), lines: verify && !reason, submits,
          ...(!reason ? { usage: { ...usage, duration_ms: Date.now() - started } } : {}) });
      });
      child.stdin.end(verify ? VERIFY_PROMPT : `${MCP_SYSTEM_PROMPT}\n${mcpPrompt(stageTools[0])}`);
    });
  } catch { return failed('spawn_failed'); }
  finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
        try { await lstat(directory); return failed('exit_failed'); }
        catch (e) { if (e.code !== 'ENOENT') return failed('exit_failed'); }
      } catch { return failed('exit_failed'); }
    }
  }
}

const namesOnly = values => Array.isArray(values)
  ? [...new Set(values.filter(value => typeof value === 'string' && /^mcp__hmp__[a-zA-Z0-9_.-]+$/.test(value)))].sort() : [];
async function catalog() {
  const value = await readJSON(pathFor('mcp-tools.json')).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
  return Object.fromEntries(Object.entries(value).filter(([, names]) => Array.isArray(names)).map(([origin, names]) => [origin, namesOnly(names)]));
}
async function save(config, names) {
  const values = await catalog();
  values[config.instance_url] = namesOnly([...(values[config.instance_url] ?? []), ...names]);
  await writeJSON(pathFor('mcp-tools.json'), values);
  return values[config.instance_url];
}
export async function runMcpClaude(config, directory, stageTools, timeoutMs, { binary = 'claude' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let names = (await catalog())[config.instance_url];
  const run = (discoverTools = false) => Date.now() >= deadline ? { status: 'failed', reason: 'timeout', lines: false, submits: 0 }
    : runClaude(directory, stageTools[0], deadline - Date.now(), {
      binary, mcpOnly: true, checkTools: true, discoverTools,
      disallowedTools: (names ?? []).filter(name => !stageTools.includes(name)),
    });
  if (!names?.length) {
    const probe = await run(true);
    if (probe.reason !== 'tools_collected') return probe;
    names = await save(config, probe.tools);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run();
    if (result.reason !== 'tools_unexpected') return result;
    names = await save(config, result.tools);
  }
  return { status: 'failed', reason: 'tools_unexpected', lines: false, submits: 0 };
}
