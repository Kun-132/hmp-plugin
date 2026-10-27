import { isOffrecord } from './offrecord.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadToken } from './config.mjs';
import { suppressed, writeJSON, pathFor } from './state.mjs';
import { automated, cachedSummary, recordTurn } from './turns.mjs';
import { enqueue, flush, makeEvent } from './events.mjs';
import { request, serverSummary } from './client.mjs';
import { workerLocked } from './worker.mjs';

async function startWorker(config) {
  if (await workerLocked(config)) return;
  const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  worker.on('error', () => {}); worker.unref();
}

async function main() {
  const deadline = Date.now() + 3000;
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024) return;
  }
  const input = JSON.parse(text);
  const event = process.argv[2];
  const codex = process.argv[3] === 'codex';
  if (!['UserPromptSubmit', 'Stop', 'SessionStart'].includes(event)) return;
  if (await isOffrecord(input.session_id)) {
    if (event === 'SessionStart' && !codex) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'SessionStart', additionalContext: `HMP: このセッションはオフレコ\nHMP: session_id=${JSON.stringify(input.session_id)}`,
    } }) + '\n');
    return;
  }
  if (await suppressed(input.cwd)) return;
  if (event !== 'SessionStart') {
    const config = await loadConfig();
    const summary = await cachedSummary(config);
    if (event === 'UserPromptSubmit' && automated(input.prompt, summary.points)) {
      return;
    }
    const entry = makeEvent({ session_id: input.session_id, prompt_id: codex ? input.turn_id : input.prompt_id,
      prompt: input.prompt, last_assistant_message: input.last_assistant_message }, event === 'Stop' ? 'response' : 'prompt');
    if (!entry && !(event === 'Stop' && summary.points)) return;
    if (entry) await enqueue(entry, config);
    if (summary.points) await recordTurn(config, input.session_id, entry, {
      prompt: event === 'UserPromptSubmit',
      complete: event === 'Stop' && (codex || input.background_tasks === undefined || Array.isArray(input.background_tasks) && !input.background_tasks.length),
    });
    try {
      const token = await loadToken(config);
      await flush(config, token, { deadline, max: 50 });
    } finally { if (event === 'Stop' && summary.points && !summary.paused) await startWorker(config); }
    return;
  }
  const context = typeof input.session_id === 'string' && input.session_id
    ? [`HMP: get_context_packet を呼ぶときは session_id=${input.session_id} を渡す`] : [];
  try {
    const config = await loadConfig();
    const token = await loadToken(config);
    if (!token) return;
    if (!codex) try { await flush(config, token, { deadline: Math.min(deadline, Date.now() + 1800), max: 200 }); } catch {}
    // The 750 ms request default aborts a cold TLS + D1 config read; the worker then never learns of pending work.
    const remote = await request(config, token, '/api/client/config', { deadline, timeout: deadline - Date.now() });
    const summary = { ...serverSummary(remote), instance_origin: config.instance_url };
    await writeJSON(pathFor('server-config.json'), summary);
    if (summary.notice) context.push('HMP プラグインの更新があります: claude plugin update hmp@hmp-marketplace');
    if (!codex && !summary.points && !summary.paused && (summary.pending.extraction || summary.pending.lines)) await startWorker(config);
  } finally {
    if (!codex && context.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'SessionStart', additionalContext: context.join('\n'),
    } }) + '\n');
  }
}
// A closed/broken input, unexpected exception or deadline never blocks a conversation.
const watchdog = setTimeout(() => process.exit(0), 4100);
process.stdout.on('error', () => process.exit(0));
main().catch(() => {}).finally(() => { clearTimeout(watchdog); process.exitCode = 0; });
