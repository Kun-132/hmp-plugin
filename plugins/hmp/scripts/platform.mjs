import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep, win32 } from 'node:path';

// Windows needs these to start cmd.exe and to find the CLI's own config, not just PATH and HOME.
export const WINDOWS_ENV = Object.freeze(['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE',
  'COMSPEC', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMFILES', 'CLAUDE_CODE_GIT_BASH_PATH']);
export function platformEnv(env = process.env, platform = process.platform) {
  return platform === 'win32' ? Object.fromEntries(WINDOWS_ENV.filter(key => env[key] !== undefined).map(key => [key, env[key]])) : {};
}
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
export function resolveCommand(name, { platform = process.platform, env = process.env, exists = isFile } = {}) {
  if (platform !== 'win32') return name;
  if (win32.isAbsolute(name)) return exists(name) ? name : null;
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    for (const ext of win32.extname(name) ? [''] : exts) {
      const path = win32.join(dir.replace(/^"|"$/g, ''), name + ext.toLowerCase());
      if (exists(path)) return path;
    }
  }
  return null;
}
const META = /([()\][%!^"`<>&|;, *?])/g;
// cmd.exe re-reads a shim's %* line, where these act even inside our quoting, so refuse them instead of escaping twice.
const SHIM_UNSAFE = /[%!^&|<>\r\n\0]/;
function quote(arg) {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(META, '^$1');
}
export function launchSpec(name, args, { platform = process.platform, env = process.env, exists = isFile } = {}) {
  const command = resolveCommand(name, { platform, env, exists });
  if (!command) throw Object.assign(Error('command_missing'), { code: 'ENOENT' });
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return { command, args, options: platform === 'win32' ? { windowsHide: true } : {} };
  if ([command, ...args].some(arg => SHIM_UNSAFE.test(arg))) throw Object.assign(Error('unsafe_argument'), { code: 'EINVAL' });
  const line = [command.replace(META, '^$1'), ...args.map(quote)].join(' ');
  return { command: env.COMSPEC || env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true, windowsHide: true } };
}
// A new process group lets POSIX kill the whole tree; on Windows detached would only open a console window.
export function spawnCommand(name, args, options, { platform = process.platform, run = spawn, exists = isFile } = {}) {
  const spec = launchSpec(name, args, { platform, env: options.env ?? process.env, exists });
  return run(spec.command, spec.args, { ...options, ...spec.options, detached: platform !== 'win32' });
}
// execFile's own timeout would end only cmd.exe on Windows and leave the CLI under it running.
export function execCommand(name, args, { timeout, ...options }, { platform = process.platform, run = execFile, exists = isFile } = {}) {
  const spec = launchSpec(name, args, { platform, env: options.env ?? process.env, exists });
  if (platform !== 'win32') return promisify(run)(spec.command, spec.args, { ...options, timeout });
  return new Promise((resolvePromise, reject) => {
    let timer;
    const child = run(spec.command, spec.args, { ...options, ...spec.options }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) reject(error); else resolvePromise({ stdout, stderr });
    });
    if (timeout) timer = setTimeout(() => killTree(child.pid, { platform }), timeout);
  });
}
export function killTree(pid, { platform = process.platform, run = execFile, kill = process.kill.bind(process) } = {}) {
  if (!pid) return;
  if (platform === 'win32') { try { run('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => {}); } catch {} return; }
  try { kill(-pid, 'SIGKILL'); } catch {}
}
// Claude Code matches Windows permission paths in POSIX form: C:\Users\a becomes /c/Users/a.
export function permissionPath(directory, platform = process.platform) {
  if (platform !== 'win32') return directory;
  const drive = /^([A-Za-z]):[\\/]/.exec(directory);
  return drive ? `/${drive[1].toLowerCase()}/${directory.slice(3).split(/[\\/]/).filter(Boolean).join('/')}` : directory.replaceAll('\\', '/');
}
// The native call expands 8.3 names (YOSHIK~1) on Windows so both sides of the fence compare long names.
export function canonicalDirectory(directory, { platform = process.platform, realpath = realpathSync } = {}) {
  return platform === 'win32' ? realpath.native(directory) : realpath(directory);
}
export function insideDirectory(directory, path, { platform = process.platform, realpath = realpathSync, lstat = lstatSync } = {}) {
  if (typeof path !== 'string' || path.split(/[\\/]/).includes('..')) return false;
  try {
    if (platform !== 'win32') {
      return path.startsWith('/') && resolve(path).startsWith(directory + sep) && realpath(path).startsWith(directory + sep) && lstat(path).isFile();
    }
    const posix = /^\/([A-Za-z])\//.exec(path);
    const native = posix ? `${posix[1]}:\\${path.slice(3)}` : path;
    if (!/^[A-Za-z]:[\\/]/.test(native)) return false;
    const base = directory.toLowerCase() + '\\';
    return realpath.native(native).toLowerCase().startsWith(base) && lstat(native).isFile();
  } catch { return false; }
}
