import { spawnCommand, killTree } from './platform.mjs';
import { realpathSync } from 'node:fs';
import { mkdtemp, chmod, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJSON } from './state.mjs';
import { claudeEnv } from './worker.mjs';
import { codexExecArgs, codexUsage, codexEnv, ensureCodexState } from './codex-exec.mjs';

export function structuredArgs(schema, systemPrompt) {
  return ['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--settings', JSON.stringify({ disableAllHooks: true, enabledPlugins: {} }), '--no-session-persistence',
    '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--disable-slash-commands', '--no-chrome',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--system-prompt', systemPrompt];
}
export function matches(value, schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') return value && typeof value === 'object' && !Array.isArray(value)
    && (schema.required ?? []).every(key => Object.hasOwn(value, key))
    && Object.entries(value).every(([key, v]) => schema.properties?.[key] ? matches(v, schema.properties[key]) : schema.additionalProperties !== false);
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0)
    && value.length <= (schema.maxItems ?? Infinity) && value.every(v => matches(v, schema.items));
  if (schema.type === 'string') return typeof value === 'string' && [...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? Infinity);
  if (schema.type === 'integer' || schema.type === 'number') return Number.isFinite(value)
    && (schema.type !== 'integer' || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  return false;
}
export async function runStructuredClaude(directory, contract, input, validate, timeoutMs, { binary = 'claude', systemPrompt } = {}) {
  const started = Date.now();
  return new Promise(resolve => {
    let output = '', bytes = 0, failure = null;
    let child;
    try {
      child = spawnCommand(binary, structuredArgs(contract.output_schema, systemPrompt), {
        cwd: directory, env: claudeEnv(), stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch { resolve({ code: 'claude_failed' }); return; }
    const stop = code => {
      failure ??= code;
      killTree(child.pid);
    };
    const interrupt = () => stop('claude_failed');
    const timer = setTimeout(() => stop('claude_timeout'), Math.max(1, Math.min(90_000, timeoutMs)));
    process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
    child.on('error', () => stop('claude_failed'));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) stop('output_invalid'); else output += chunk;
    });
    child.on('close', code => {
      clearTimeout(timer); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
      if (failure || code !== 0) { resolve({ code: failure ?? 'claude_failed' }); return; }
      try {
        const result = JSON.parse(output);
        if (result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false ||
            !validate(result.structured_output, contract.output_schema)) throw Error();
        const usage = { duration_ms: Date.now() - started };
        for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'])
          if (Number.isSafeInteger(result.usage?.[key]) && result.usage[key] >= 0) usage[key] = result.usage[key];
        if (usage.input_tokens !== undefined) {
          const total = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          if (Number.isSafeInteger(total)) usage.input_total_tokens = total;
        }
        resolve({ output: result.structured_output, usage });
      } catch { resolve({ code: 'output_invalid' }); }
    });
    child.stdin.end(input);
  });
}
export function structuredCodexArgs(directory) {
  return codexExecArgs(directory, { outputArgs: [
    '--output-last-message', join(directory, 'out.json'), '--output-schema', join(directory, 'output-schema.json'),
  ] });
}
export async function runStructuredCodex(contract, input, validate, timeoutMs, { binary = 'codex', tempRoot = tmpdir() } = {}) {
  const started = Date.now();
  let directory;
  try {
    directory = await mkdtemp(join(tempRoot, 'hmp-points-codex-'));
    directory = realpathSync(directory);
    await chmod(directory, 0o700);
    await ensureCodexState();
    await writeFile(join(directory, 'output-schema.json'), JSON.stringify(contract.output_schema), { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'out.json'), '', { mode: 0o600, flag: 'wx' });
    const result = await new Promise(resolve => {
      const env = codexEnv();
      let child;
      const previousMask = process.umask(0o077);
      try {
        child = spawnCommand(binary, structuredCodexArgs(directory), {
          cwd: directory, env: { ...env, TMPDIR: directory }, stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch { resolve({ code: 'codex_unavailable' }); return; }
      finally { process.umask(previousMask); }
      let pending = '', bytes = 0, failure = null, usage = {};
      const stop = code => {
        failure ??= code;
        killTree(child.pid);
      };
      const interrupt = () => stop('codex_failed');
      const timer = setTimeout(() => stop('codex_timeout'), Math.max(1, Math.min(90_000, timeoutMs)));
      process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
      child.on('error', () => stop('codex_unavailable'));
      child.stdin.on('error', () => {});
      const consume = line => {
        try { usage = { ...usage, ...codexUsage(JSON.parse(line)) }; } catch {}
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) { pending = ''; stop('output_invalid'); return; }
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          consume(pending.slice(0, end)); pending = pending.slice(end + 1);
        }
      });
      child.on('close', code => {
        clearTimeout(timer); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
        if (failure || code !== 0) { resolve({ code: failure ?? 'codex_failed' }); return; }
        if (pending) consume(pending);
        resolve({ usage });
      });
      child.stdin.end(input);
    });
    if (result.code) return result;
    try {
      const output = await readJSON(join(directory, 'out.json'));
      if (!validate(output, contract.output_schema)) throw Error();
      return { output, usage: { ...result.usage, duration_ms: Date.now() - started } };
    } catch { return { code: 'output_invalid' }; }
  } catch { return { code: 'codex_failed' }; }
  finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
        try { await lstat(directory); return { code: 'codex_failed' }; }
        catch (e) { if (e.code !== 'ENOENT') return { code: 'codex_failed' }; }
      } catch { return { code: 'codex_failed' }; }
    }
  }
}
