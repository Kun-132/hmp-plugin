import { pathToFileURL } from 'node:url';
import { isOffrecord, setOffrecord, offrecordPath } from './offrecord.mjs';
import { loadConfig, loadToken, CLIENT_VERSION } from './config.mjs';
import { request } from './client.mjs';

export async function forget(args) {
  const [session, option] = args;
  if (args.length > 2 || ![undefined, '--resume', '--preview', '--confirm'].includes(option)) throw Error('usage');
  offrecordPath(session);
  if (option === '--resume') return setOffrecord(session, false);
  if (!option) return setOffrecord(session, true);
  if (!await isOffrecord(session)) throw Error('offrecord_required');
  const config = await loadConfig(), token = await loadToken(config.device);
  return request(config, token, '/api/client/forget', { body: {
    client_version: CLIENT_VERSION, device: config.device, session, scope: 'session',
    ...(option === '--preview' ? { dry_run: true } : {}),
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  forget(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(() => { process.stderr.write('HMP: オフレコ状態または接続を確認してください（詳細・秘密は表示しません）。\n'); process.exitCode = 1; });
}
