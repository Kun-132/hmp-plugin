import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readText, writeJSON, pathFor, suppressed } from './state.mjs';
import { makeEvent, hash, enqueue, flush } from './events.mjs';
import { loadConfig, loadToken } from './config.mjs';

const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n') : '';
export async function preview(from, to) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw Error('invalid_period');
  if (await suppressed(process.cwd())) throw Error('paused_or_excluded');
  const directory = join(homedir(), '.claude', 'projects');
  const canonical = await realpath(directory);
  const events = [];
  const sourceDirectories = new Set();
  for (const project of await readdir(directory, { withFileTypes: true })) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const folder = join(directory, project.name);
    for (const file of await readdir(folder, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const path = join(folder, file.name);
      if (!(await realpath(path)).startsWith(canonical + '/')) throw Error('unsafe_transcript');
      let turn = null, assistant = null;
      const finish = () => { if (assistant) events.push(assistant); assistant = null; };
      for (const line of (await readText(path, 32 * 1024 * 1024)).split('\n')) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.isSidechain || row.isMeta || row.message?.isMeta || !['user', 'assistant'].includes(row.type)) continue;
        if (typeof row.cwd !== 'string' || await suppressed(row.cwd)) { finish(); turn = null; continue; }
        sourceDirectories.add(row.cwd);
        const at = Date.parse(row.timestamp);
        if (!Number.isFinite(at) || at < start || at >= end) { finish(); turn = null; continue; }
        if (row.type === 'user' && row.message?.role === 'user') {
          // tool_result rows have role user too; only an actual text prompt starts a turn.
          const content = row.message.content;
          if (Array.isArray(content) && content.some(x => x?.type === 'tool_result')) continue;
          const prompt = textOf(content);
          if (!prompt.trim() || /^\s*<(?:system-reminder|command-name|local-command-stdout|command-message)>/.test(prompt)) continue;
          finish();
          turn = typeof row.uuid === 'string' ? row.uuid : hash(`${file.name}:${events.length}:${prompt}`);
          const event = makeEvent({ session_id: row.sessionId ?? file.name, prompt_id: turn, prompt, occurred_at: new Date(at).toISOString() }, 'prompt');
          if (event) events.push(event);
        }
        if (row.type === 'assistant' && row.message?.role === 'assistant' && turn) {
          const content = row.message.content;
          if (Array.isArray(content) && content.some(x => x?.type === 'tool_use')) { assistant = null; continue; }
          const response = textOf(content);
          if (response.trim() && !['tool_use', 'pause_turn'].includes(row.message.stop_reason)) {
            assistant = makeEvent({ session_id: row.sessionId ?? file.name, prompt_id: turn,
              last_assistant_message: response, occurred_at: new Date(at).toISOString() }, 'response');
          }
        }
      }
      finish();
    }
  }
  const id = randomUUID();
  const unique = [...new Map(events.map(event => [event.client_event_id, event])).values()];
  await writeJSON(pathFor(`onboard/${id}.json`), { from: new Date(start).toISOString(), to: new Date(end).toISOString(),
    sourceDirectories: [...sourceDirectories], events: unique }, true);
  return { plan: id, from: new Date(start).toISOString(), to_exclusive: new Date(end).toISOString(), count: unique.length };
}
export async function send(plan, confirmedCount) {
  if (!/^[a-f0-9-]{36}$/.test(plan)) throw Error('invalid_plan');
  if (await suppressed(process.cwd())) throw Error('paused_or_excluded');
  const data = JSON.parse(await readText(pathFor(`onboard/${plan}.json`), 64 * 1024 * 1024));
  if (String(data.events.length) !== confirmedCount) throw Error('count_changed');
  for (const cwd of data.sourceDirectories) if (await suppressed(cwd)) throw Error('source_now_excluded');
  const config = await loadConfig(), token = await loadToken(config.device);
  if (!token) throw Error('no_token');
  for (const event of data.events) await enqueue(event);
  await flush(config, token, { deadline: Date.now() + 30_000, max: data.events.length });
  return { queued: data.events.length, period: { from: data.from, to: data.to } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, a, b, confirm] = process.argv.slice(2);
  const action = command === 'preview' ? preview(a, b) : command === 'send' && confirm === '--approved' ? send(a, b) : Promise.reject(Error('approval_required'));
  action.then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(() => { process.stderr.write('HMP: 期間・除外・一時停止・了承を確認してください。\n'); process.exitCode = 1; });
}
