import { WINDOWS_ENV } from './platform.mjs';
import { join } from 'node:path';
import { pathFor, privateDir } from './state.mjs';

// A fresh sqlite_home per run costs Codex about 28 s of state setup; --ephemeral and history none keep record text out of it.
export const codexStateDir = () => pathFor('codex-state');
export const ensureCodexState = () => privateDir(codexStateDir());

export function codexExecArgs(directory, { outputArgs = [], mcpConfig = ['mcp_servers={}'] } = {}) {
  return ['--no-daemon', '--strict-config', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', directory, '--json',
    ...outputArgs,
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'tool_output_token_limit=100000',
    ...mcpConfig.flatMap(value => ['-c', value]), '-c', 'history.persistence="none"',
    '-c', `log_dir=${JSON.stringify(join(directory, 'logs'))}`, '-c', `sqlite_home=${JSON.stringify(codexStateDir())}`,
    '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false',
    ...['view_image', 'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin', 'hooks',
      'multi_agent', 'memories', 'goals', 'browser_use', 'computer_use', 'image_generation', 'code_mode',
      'standalone_web_search'].flatMap(feature => ['--disable', feature]), '-'];
}
export function codexUsage(event) {
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  if (event?.type !== 'turn.completed') return {};
  const { input_tokens: input, cached_input_tokens: cached, output_tokens: output } = event.usage ?? {};
  const usage = {};
  if (valid(input)) {
    usage.input_total_tokens = input;
    if (valid(cached) && cached <= input) {
      usage.input_tokens = input - cached;
      usage.cache_read_input_tokens = cached;
    }
  }
  if (valid(output)) usage.output_tokens = output;
  return usage;
}
const WINDOWS_KEYS = () => process.platform === 'win32' ? WINDOWS_ENV : [];
export function codexEnv() {
  return Object.fromEntries([...WINDOWS_KEYS(), 'PATH', 'HOME', 'USER', 'LOGNAME', 'CODEX_HOME']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}
