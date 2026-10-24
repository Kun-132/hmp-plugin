import { isOffrecord } from './offrecord.mjs';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadToken, validateConfig, validateMcp, CLIENT_VERSION } from './config.mjs';
import { readJSON, writeJSON, pathFor, filesIn } from './state.mjs';
import { manual, request } from './client.mjs';
import { redact } from './events.mjs';

export async function changeFiles(changes) {
  for (const [name, value] of Object.entries(changes)) {
    if (!['config.json', 'mcp.json', 'pause'].includes(name) || !value || typeof value !== 'object') throw Error('invalid_change');
    if (name === 'config.json') {
      if (Object.keys(value).some(key => !['instance_url', 'device'].includes(key))) throw Error('unknown_config_fields');
      changes[name] = validateConfig(value);
    }
    if (name === 'pause') {
      if (Object.keys(value).some(key => key !== 'until')) throw Error('unknown_config_fields');
      changes[name] = { until: new Date(value.until).toISOString() };
    }
    if (name === 'mcp.json') changes[name] = validateMcp(value,
      validateConfig(changes['config.json'] ?? await readJSON(pathFor('config.json'))));
  }
  const id = `${Date.now()}-${process.pid}`;
  const before = {};
  for (const name of Object.keys(changes)) {
    try { before[name] = await readJSON(pathFor(name)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; before[name] = null; }
    // Refuse a legacy config containing secret/unknown fields rather than copying it.
    const allowed = name === 'config.json' ? ['instance_url', 'device'] : name === 'pause' ? ['until'] : ['mcpServers'];
    if (before[name] && Object.keys(before[name]).some(key => !allowed.includes(key))) throw Error('unknown_config_fields');
    if (name === 'mcp.json' && before[name]) before[name] = validateMcp(before[name],
      validateConfig(before['config.json'] ?? await readJSON(pathFor('config.json'))));
    if (name === 'config.json' && before[name]) before[name] = validateConfig(before[name]);
    if (name === 'pause' && before[name] && !Number.isFinite(Date.parse(before[name].until))) throw Error('invalid_pause');
  }
  const backup = `backups/${id}.json`;
  await writeJSON(pathFor(backup), before, true);
  const record = { backup, diff: Object.keys(changes).map(name => ({ file: name, before: before[name], after: changes[name] })),
    restore: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" restore ${id}`, verified: false };
  await writeJSON(pathFor(`changes/${id}.json`), record, true);
  for (const [name, value] of Object.entries(changes)) await writeJSON(pathFor(name), value);
  for (const [name, value] of Object.entries(changes)) {
    if (JSON.stringify(await readJSON(pathFor(name))) !== JSON.stringify(value)) throw Error('verification_failed');
  }
  record.verified = true;
  await writeJSON(pathFor(`changes/${id}.json`), record);
  return record;
}
export async function manage(args) {
  const [command, ...rest] = args;
  if (command === 'setup') {
    if (rest.length !== 2) throw Error('usage');
    const config = validateConfig({ instance_url: rest[0], device: rest[1] });
    return changeFiles({ 'config.json': config, 'mcp.json': { mcpServers: { hmp: { type: 'http', url: config.instance_url + '/mcp' } } } });
  }
  if (command === 'pause') {
    if (rest.length !== 1 || !/^\d+$/.test(rest[0]) || Number(rest[0]) > 525600) throw Error('invalid_duration');
    return changeFiles({ pause: { until: new Date(Date.now() + Number(rest[0]) * 60_000).toISOString() } });
  }
  if (command === 'verify') {
    const config = await loadConfig(), token = await loadToken(config.device);
    const remote = await request(config, token, '/api/client/config', manual());
    const label = typeof remote.instance_label === 'string' ? remote.instance_label : '';
    return { instance_label: redact(label.split(token).join('<SECRET>')).replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 80), connected: true };
  }
  if (command === 'status') {
    if (rest.length && await isOffrecord(rest[0])) return { client_version: CLIENT_VERSION, offrecord: true, notice: 'このセッションはオフレコ' };
    const last = await readJSON(pathFor('last-send.json')).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    let pending = null;
    const config = await loadConfig(), token = await loadToken(config.device);
    try { pending = (await import('./client.mjs')).serverSummary(await request(config, token, '/api/client/config', manual())).pending; } catch {}
    return { client_version: CLIENT_VERSION, spool: (await filesIn('spool')).filter(x => /^[a-f0-9]{64}\.json$/.test(x)).length,
      last_send: last?.sent_at ?? null, pending };
  }
  if (command === 'restore') {
    if (!/^\d+-\d+$/.test(rest[0]) || rest.length !== 1) throw Error('invalid_backup');
    const before = await readJSON(pathFor(`backups/${rest[0]}.json`));
    // Missing originals become inert settings; restoration never deletes a file.
    const changes = {};
    for (const [name, value] of Object.entries(before)) {
      if (!['config.json', 'mcp.json', 'pause'].includes(name)) throw Error('invalid_backup');
      if (value !== null) changes[name] = value;
      else if (name === 'pause') changes[name] = { until: new Date().toISOString() };
      else throw Error('new_install_uninstall_manually');
    }
    return changeFiles(changes);
  }
  throw Error('usage');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  manage(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(() => { process.stderr.write('HMP: 設定または接続を確認してください（詳細・秘密は表示しません）。\n'); process.exitCode = 1; });
}
