import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('marketplace/plugin/hooks follow required structure without manifest versions', async () => {
  const json = async file => JSON.parse(await readFile(file, 'utf8'));
  const market = await json('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'hmp-marketplace'); assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].source, './plugins/hmp'); assert.equal('version' in market, false);
  assert.equal('version' in market.plugins[0], false); assert.ok(market.owner.name);
  const plugin = await json('plugins/hmp/.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'hmp'); assert.equal(plugin.displayName, 'HMP'); assert.equal('version' in plugin, false);
  const config = await json('plugins/hmp/hooks/hooks.json');
  assert.deepEqual(Object.keys(config.hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
  for (const [event, entries] of Object.entries(config.hooks)) {
    assert.equal(entries.length, 1); assert.equal(entries[0].hooks.length, 1);
    const hook = entries[0].hooks[0]; assert.equal(hook.type, 'command'); assert.equal(hook.timeout, 5);
    assert.equal(hook.async === true, event === 'Stop');
    assert.equal(hook.command, `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" ${event}`);
  }
  for (const name of ['setup', 'pause', 'status', 'onboard']) {
    const text = await readFile(`plugins/hmp/skills/${name}/SKILL.md`, 'utf8');
    assert.ok(text.includes('disable-model-invocation: true')); assert.ok(text.length < 1600);
  }
});
