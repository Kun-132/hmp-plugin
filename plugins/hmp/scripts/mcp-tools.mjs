import { pathFor, readJSON, writeJSON } from './state.mjs';
import { runClaude } from './worker.mjs';

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
