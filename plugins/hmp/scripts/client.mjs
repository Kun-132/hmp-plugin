import { CLIENT_VERSION } from './config.mjs';

// Requests default to 750 ms; event batches use the remaining hook deadline, manual commands wait longer.
export const manual = () => ({ deadline: Date.now() + 8000, timeout: 8000 });
export async function request(config, token, path, { body, deadline = Date.now() + 750, timeout = 750 } = {}) {
  if (!token || deadline <= Date.now()) throw Error('unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeout, deadline - Date.now()));
  try {
    const response = await fetch(config.instance_url + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-HMP-Client-Version': CLIENT_VERSION },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Error('http_error');
    let text = '', bytes = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 128 * 1024) { controller.abort(); throw Error('response_limit'); }
      text += decoder.decode(chunk, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { clearTimeout(timer); }
}
export function serverSummary(value) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const limits = {};
  for (const key of ['max_runs_per_day', 'max_items_per_run', 'max_minutes']) {
    if (value?.limits && key in value.limits) limits[key] =
      Number.isFinite(value.limits[key]) && value.limits[key] >= 0 ? Math.floor(value.limits[key]) : 0;
  }
  return { pending: { extraction: count(value?.pending?.extraction), lines: count(value?.pending?.lines) },
    limits, paused: value?.paused === true || (Array.isArray(value?.paused_sources) && value.paused_sources.includes('claude_code_hook')),
    notice: Boolean(value?.notice),
    ...(typeof value?.instance_origin === 'string' ? { instance_origin: value.instance_origin } : {}),
    ...(value?.points && typeof value.points === 'object' ? { points: {
      contract_version: value.points.contract_version, instructions: value.points.instructions,
      output_schema: value.points.output_schema,
      automated_prefixes: Array.isArray(value.points.automated_prefixes)
        ? value.points.automated_prefixes.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()) : [],
      limits: value.points.limits && typeof value.points.limits === 'object' ? Object.fromEntries(
        ['max_turns_per_day', 'max_turns_per_run', 'max_seconds_per_turn'].filter(k => k in value.points.limits).map(k => [k, value.points.limits[k]])) : {},
    } } : {}) };
}
