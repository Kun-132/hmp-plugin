import { CLIENT_VERSION } from './config.mjs';
import { request } from './client.mjs';
import { pathFor, readJSON, writeJSON } from './state.mjs';
import { recordFailure } from './turns.mjs';
import { matches, runStructuredClaude, runStructuredCodex } from './structured-output.mjs';

export const LINES_MAXIMUM = Object.freeze({ max_claims_per_run: 4, max_claims_per_turn: 2,
  max_launches_per_day: 600, max_seconds_per_turn: 90 });
export function linesLimits(limits = {}) {
  return Object.fromEntries(Object.entries(LINES_MAXIMUM).map(([key, max]) => [key,
    Object.hasOwn(limits, key) ? Number.isFinite(limits[key]) && limits[key] >= 0 ? Math.min(max, Math.floor(limits[key])) : 0 : max]));
}
export function validateLineOutput(value, schema) {
  return matches(value, schema) && Object.keys(value).join(',') === 'blocks' && Array.isArray(value.blocks)
    && value.blocks.length <= 50 && value.blocks.every(block => block && typeof block.text === 'string' && block.text.trim()
      && ['kind', 'prev', 'seen', 'grounds'].every(key => Object.hasOwn(block, key)));
}
async function lineBudget(config, limits, reserve = false) {
  const day = new Date().toISOString().slice(0, 10);
  let usage = await readJSON(pathFor('lines-usage.json')).catch(e => { if (e.code === 'ENOENT') return { day, launches: 0 }; throw e; });
  if (usage.day !== day) usage = { day, launches: 0 };
  if (!Number.isSafeInteger(usage.launches) || usage.launches < 0 || usage.launches >= limits.max_launches_per_day) {
    await recordFailure(config, 'lines_daily_limit'); return false;
  }
  // Count before launch; a crash or failed model never refunds a launch.
  if (reserve) await writeJSON(pathFor('lines-usage.json'), { day, launches: usage.launches + 1 });
  return true;
}
export function createLinesStage(config, token, contract, { directory, engine, seconds, state }) {
  const limits = linesLimits(contract?.limits);
  limits.max_seconds_per_turn = Math.min(limits.max_seconds_per_turn, seconds);
  const fail = async code => {
    state.stopped = true;
    await recordFailure(config, code).catch(() => {});
  };
  return async allowed => {
    try {
      if (!contract || state.stopped || !Object.values(limits).every(n => n > 0)) return;
      if (contract.contract_version !== 'hmp-client-lines-v1' || typeof contract.instructions !== 'string'
          || contract.output_schema?.type !== 'object') { await fail('lines_contract_invalid'); return; }
      const body = { client_version: CLIENT_VERSION, device: config.device };
      for (let i = 0; i < limits.max_claims_per_turn && state.claims < limits.max_claims_per_run; i++) {
        if (!await allowed()) return;
        if (!await lineBudget(config, limits)) { state.stopped = true; return; }
        state.claims++;
        const { item } = await request(config, token, '/api/client/lines/claim', { body, deadline: Date.now() + 8000, timeout: 8000 });
        if (item === null) return;
        if (!item || typeof item.capture_id !== 'string' || !item.capture_id || typeof item.lease_id !== 'string' || !item.lease_id) {
          await fail('lines_output_invalid'); return;
        }
        if (!await allowed()) return;
        if (!await lineBudget(config, limits, true)) { state.stopped = true; return; }
        const input = JSON.stringify(item), timeout = limits.max_seconds_per_turn * 1000;
        const result = engine === 'codex'
          ? await runStructuredCodex(contract, `${contract.instructions}\n\n${input}`, validateLineOutput, timeout)
          : await runStructuredClaude(directory, contract, input, validateLineOutput, timeout, { systemPrompt: contract.instructions });
        if (result.code) {
          await fail(result.code.endsWith('_timeout') ? 'lines_model_timeout'
            : result.code === 'output_invalid' ? 'lines_output_invalid' : 'lines_model_failed'); return;
        }
        if (!await allowed()) return;
        const receipt = await request(config, token, '/api/client/lines/submit', { body: {
          ...body, capture_id: item.capture_id, lease_id: item.lease_id, blocks: result.output.blocks,
        }, deadline: Date.now() + 8000, timeout: 8000 });
        if (receipt.status !== 'accepted') { await fail('lines_rejected'); return; }
      }
    } catch (e) {
      if ([404, 426].includes(e.status)) { state.stopped = true; return; }
      await fail('lines_unavailable');
    }
  };
}
