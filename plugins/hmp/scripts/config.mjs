import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathFor, readJSON } from './state.mjs';

export const CLIENT_VERSION = '0.1.0';
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
export async function loadToken(device, { platform = process.platform, run = promisify(execFile), env = process.env } = {}) {
  let token;
  if (platform === 'darwin') {
    try { token = (await run('security', ['find-generic-password', '-s', 'hmp-client', '-a', device, '-w'],
      { timeout: 350, maxBuffer: 8192, encoding: 'utf8' })).stdout.trim(); } catch { return null; }
  } else token = env.HMP_CLIENT_TOKEN;
  return typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(token) ? token : null;
}
