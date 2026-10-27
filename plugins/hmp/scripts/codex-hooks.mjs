import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pathFor, privateDir, readJSON, readText, writeJSON } from './state.mjs';

const events = ['UserPromptSubmit', 'Stop', 'SessionStart'];
const command = event => `node "$HOME/.hmp/bin/codex-hook.mjs" ${event}`;
const owned = (hook, event) => hook?.type === 'command' && hook.command === command(event);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const statePath = () => pathFor('codex-hooks-state.json');
const hooksPath = () => join(homedir(), '.codex/hooks.json');

// Re-serializing the document would change unrelated tools' bytes and whitespace.
function tree(text) {
  JSON.parse(text);
  let at = 0;
  const space = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === '\\') at++;
      else if (ch === '"') return JSON.parse(text.slice(start, at));
    }
    throw Error('invalid_json');
  };
  const value = () => {
    space();
    const start = at, ch = text[at], items = [];
    if (ch === '{' || ch === '[') {
      at++; space();
      const keys = new Set();
      while (text[at] !== (ch === '{' ? '}' : ']')) {
        space();
        const memberStart = at;
        let key;
        if (ch === '{') {
          key = string(); space(); at++;
          if (keys.has(key)) throw Error('duplicate_key');
          keys.add(key);
        }
        const node = value();
        items.push({ key, start: memberStart, end: at, node });
        space();
        if (text[at] !== ',') break;
        at++;
      }
      at++;
    } else if (ch === '"') string();
    else while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
    return { start, end: at, items, value: JSON.parse(text.slice(start, at)) };
  };
  return value();
}
const member = (node, key) => node.items.find(item => item.key === key)?.node;
const splice = (text, start, end, replacement = '') => text.slice(0, start) + replacement + text.slice(end);
function append(text, node, content) {
  const last = node.items.at(-1);
  return splice(text, last?.end ?? node.start + 1, last?.end ?? node.start + 1, (last ? ',' : '') + content);
}
function discard(text, node, index) {
  const item = node.items[index], previous = node.items[index - 1], next = node.items[index + 1];
  return splice(text, previous?.end ?? item.start, previous ? item.end : next?.start ?? item.end);
}
function validate(text) {
  const root = tree(text);
  if (!object(root.value) || root.value.hooks !== undefined && !object(root.value.hooks)) throw Error('invalid_hooks');
  for (const event of events) {
    const groups = root.value.hooks?.[event];
    if (groups !== undefined && (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks)))) throw Error('invalid_hooks');
  }
  return root;
}
function edit(text, action, baseline) {
  let root = validate(text);
  if (action === 'install') {
    if (!member(root, 'hooks')) text = append(text, root, '"hooks":{}');
    for (const event of events) {
      root = validate(text);
      const hooks = member(root, 'hooks'), groups = member(hooks, event);
      if (groups?.value.some(group => group.hooks.some(hook => owned(hook, event)))) continue;
      const group = JSON.stringify({ hooks: [{ type: 'command', command: command(event), timeout: 5 }] });
      text = groups ? append(text, groups, group) : append(text, hooks, JSON.stringify(event) + ':[' + group + ']');
    }
  } else {
    for (const event of events) {
      for (;;) {
        root = validate(text);
        const groups = member(member(root, 'hooks') ?? { items: [] }, event);
        const groupIndex = groups?.value.findIndex(group => group.hooks.some(hook => owned(hook, event))) ?? -1;
        if (groupIndex < 0) break;
        const group = groups.items[groupIndex].node, hooks = member(group, 'hooks');
        const index = hooks.value.findIndex(hook => owned(hook, event));
        text = hooks.items.length === 1 && Object.keys(group.value).length === 1
          ? discard(text, groups, groupIndex) : discard(text, hooks, index);
      }
      root = validate(text);
      const hooks = member(root, 'hooks'), groups = hooks && member(hooks, event);
      if (groups?.items.length === 0 && baseline?.hooks?.[event] === undefined) {
        text = discard(text, hooks, hooks.items.findIndex(item => item.key === event));
      }
    }
    root = validate(text);
    const hooks = member(root, 'hooks');
    if (hooks?.items.length === 0 && baseline?.hooks === undefined) text = discard(text, root, root.items.findIndex(item => item.key === 'hooks'));
  }
  validate(text);
  return text;
}

async function codexDirectory(create = false) {
  const path = dirname(hooksPath());
  if (create) try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw Error('unsafe_directory');
}
async function currentText() {
  try { await codexDirectory(); return await readText(hooksPath()); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function writeText(path, text, hmp = false) {
  if (hmp) await privateDir(dirname(path));
  else await codexDirectory(true);
  const info = await lstat(path).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw Error('unsafe_file');
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  const file = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  await rename(tmp, path);
  await chmod(path, 0o600);
  if (await readText(path) !== text) throw Error('verification_failed');
}
const state = () => readJSON(statePath()).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
const digest = text => text === null ? null : createHash('sha256').update(text).digest('hex');
async function change(before, after, nextState, action, launcher = false) {
  const id = `${Date.now()}-${process.pid}`, backup = `backups/${id}.json`;
  await writeJSON(pathFor(backup), { codex_hooks: { text: before, state: await state() } }, true);
  const counts = (text, event) => (JSON.parse(text ?? '{}').hooks?.[event] ?? [])
    .reduce((count, group) => count + group.hooks.filter(hook => owned(hook, event)).length, 0);
  const record = { backup, diff: [{ file: '~/.codex/hooks.json', action,
    hooks: events.map(event => ({ event, command: command(event), before: counts(before, event), after: counts(after, event) })),
    before_sha256: digest(before), after_sha256: digest(after) }],
    restore: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" restore ${id}`,
    remove: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/manage.mjs" codex-hooks remove', verified: false };
  await writeJSON(pathFor(`changes/${id}.json`), record, true);
  if (launcher) {
    const source = await readText(fileURLToPath(new URL('./codex-hook.mjs', import.meta.url)));
    await writeText(pathFor('bin/codex-hook.mjs'), source, true);
  }
  if (before !== after) {
    if (after === null) await unlink(hooksPath());
    else await writeText(hooksPath(), after);
  }
  if (nextState) await writeJSON(statePath(), nextState);
  else await unlink(statePath()).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (await currentText() !== after) throw Error('verification_failed');
  if (JSON.stringify(await state()) !== JSON.stringify(nextState)) throw Error('verification_failed');
  record.verified = true;
  await writeJSON(pathFor(`changes/${id}.json`), record);
  return record;
}
export async function codexHooks(action) {
  if (!['install', 'remove', 'status'].includes(action)) throw Error('usage');
  const before = await currentText(), root = validate(before ?? '{}').value;
  if (action === 'status') return { installed: events.every(event => root.hooks?.[event]?.some(group => group.hooks.some(hook => owned(hook, event)))) };
  const saved = await state();
  if (saved && !(saved.baseline === null || typeof saved.baseline === 'string')) throw Error('invalid_state');
  const baseline = saved ? saved.baseline : before;
  let after = edit(before ?? '{}', action, JSON.parse(baseline ?? '{}'));
  if (action === 'remove' && baseline === null && Object.keys(JSON.parse(after)).length === 0) after = null;
  if (action === 'remove' && before === after && !saved) return { installed: false };
  return change(before, after, action === 'install' ? { baseline } : null, action, action === 'install');
}
export async function restoreCodexHooks(backup) {
  if (!object(backup) || !(backup.text === null || typeof backup.text === 'string') ||
      !(backup.state === null || object(backup.state) && (backup.state.baseline === null || typeof backup.state.baseline === 'string'))) throw Error('invalid_backup');
  if (backup.text !== null) validate(backup.text);
  return change(await currentText(), backup.text, backup.state, 'restore');
}
