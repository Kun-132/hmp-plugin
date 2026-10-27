import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';

const dead = { pid: 999999999, started_at: new Date(0).toISOString(), token: 'dead' };
test('review: reclaim rereads the shared lock under its guard without moving a live replacement', async t => {
  const f = await fixture(t); await f.write('worker.lock', dead);
  const shim = join(f.home, 'replace-before-reclaim.mjs');
  await writeFile(shim, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const path = process.env.HOME + '/.hmp/worker.lock';
let replaced = false;
for (const key of ['open', 'rename']) {
  const original = fs.promises[key];
  fs.promises[key] = async (file, ...args) => {
    if (!replaced && (key === 'open' && file === path + '.reclaim' || key === 'rename' && file === path)) {
      replaced = true; fs.writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'live' }));
    }
    const result = await original(file, ...args);
    if (key === 'rename' && file === path) fs.writeFileSync(process.env.HOME + '/moved-live-owner', '');
    return result;
  };
} syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS += ' --import=' + shim;
  assert.equal((await f.run('worker.mjs')).code, 0);
  await assert.rejects(stat(join(f.home, 'moved-live-owner')), { code: 'ENOENT' });
  assert.equal((await f.read('worker.lock')).token, 'live');
});
for (const old of [false, true]) {
  test(`review: ${old ? 'expired' : 'active'} reclaim guard controls stale-lock removal`, async t => {
    const f = await fixture(t); await f.write('worker.lock', dead); await f.write('worker.lock.reclaim', { token: 'collector' });
    if (old) await utimes(join(f.home, '.hmp/worker.lock.reclaim'), new Date(0), new Date(0));
    assert.equal((await f.run('worker.mjs')).code, 0);
    assert.equal((await f.names('.')).includes('worker.lock'), !old);
    if (!old) assert.deepEqual(await f.read('worker.lock'), dead);
  });
}
