import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pathFor, readJSON, writeJSON } from './state.mjs';

export const CLIENT_VERSION = '0.2.0';
export function validateConfig(value) {
  if (!value || typeof value.instance_url !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.device ?? '')) throw Error('invalid_config');
  const url = new URL(value.instance_url);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw Error('invalid_url');
  return { instance_url: url.origin, device: value.device };
}
export const loadConfig = async () => validateConfig(await readJSON(pathFor('config.json')));
export function validateMcp(value, config) {
  const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  const hmp = value?.mcpServers?.hmp;
  if (!exact(value, ['mcpServers']) || !exact(value.mcpServers, ['hmp']) || !exact(hmp, ['type', 'url']) ||
      hmp.type !== 'http' || hmp.url !== config.instance_url + '/mcp') throw Error('unsafe_mcp');
  return { mcpServers: { hmp: { type: 'http', url: hmp.url } } };
}
export const credentialAccount = config => `${config.device}@${new URL(config.instance_url).hostname}`;
const bindingPath = account => pathFor(`credential-origins/${createHash('sha256').update(account).digest('hex')}.json`);
async function binding(account) {
  const value = await readJSON(bindingPath(account)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (value && (Object.keys(value).length !== 2 || value.account !== account ||
    validateConfig({ instance_url: value.origin, device: 'binding' }).instance_url !== value.origin)) throw Error('invalid_credential_binding');
  return value;
}
async function bind(account, origin) {
  try { await writeJSON(bindingPath(account), { account, origin }, true); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  if ((await binding(account))?.origin !== origin) throw Error('credential_origin_conflict');
}
export async function bindCredentials(previous, config) {
  const account = credentialAccount(config), existing = await binding(account);
  if (existing && existing.origin !== config.instance_url) throw Error('credential_origin_conflict');
  // A new destination must not acquire the unqualified account from the previous installation.
  if (previous && !await binding(credentialAccount(previous)) && !await binding(previous.device)) {
    await bind(previous.device, previous.instance_url);
  }
  await bind(account, config.instance_url);
  return { service: 'hmp-client', account };
}
export async function loadToken(value, { platform = process.platform, run = promisify(execFile), env = process.env, lookup = binding } = {}) {
  const config = validateConfig(value);
  const valid = token => typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(token);
  if (platform !== 'darwin') return env.HMP_CLIENT_ORIGIN === config.instance_url && valid(env.HMP_CLIENT_TOKEN) ? env.HMP_CLIENT_TOKEN : null;
  for (const account of [credentialAccount(config), config.device]) {
    if ((await lookup(account))?.origin !== config.instance_url) continue;
    let token;
    try { token = (await run('security', ['find-generic-password', '-s', 'hmp-client', '-a', account, '-w'],
      { timeout: 350, maxBuffer: 8192, encoding: 'utf8' })).stdout.trim(); } catch { continue; }
    if (valid(token)) return token;
  }
  return null;
}
