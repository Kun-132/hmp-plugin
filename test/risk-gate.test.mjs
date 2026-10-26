import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, globToRegExp, classify, ownerApproval, judge } from '../scripts/risk-gate.mjs';

const config = parseConfig(readFileSync(new URL('../.github/risk-paths.yml', import.meta.url), 'utf8'));
const headSha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);
const review = (state = 'APPROVED', overrides = {}) => ({
  id: 1, user: { login: 'Kun-132', type: 'User' }, state, commit_id: headSha,
  submitted_at: '2026-10-26T01:00:00Z', ...overrides,
});
const verdict = (overrides = {}) => judge({
  files: ['README.md'], reviews: [], headSha, baseRef: 'main', config, ...overrides,
});

test('reads the shipped approver and exact CI/dependency boundary', () => {
  assert.deepEqual(config, {
    approvers: ['Kun-132'],
    high: { ci: ['.github/**', 'scripts/risk-gate.mjs', 'package.json', 'package-lock.json', '.npmrc'] },
  });
});

test('configuration supports comments, quoted items and multiple categories', () => {
  assert.deepEqual(parseConfig(`# intent
approvers:
  - 'Owner' # human
high:
  ci:
    - ".github/**"
  dependencies:
    - package.json
`), { approvers: ['Owner'], high: { ci: ['.github/**'], dependencies: ['package.json'] } });
});

test('missing approvers, missing paths and malformed list entries fail closed', () => {
  for (const text of ['', 'approvers:\n  - Owner', 'high:\n  ci:\n    - .github/**',
    'approvers:\n  - Owner\nhigh:\n  ci:\n    .github/**']) {
    assert.throws(() => parseConfig(text), /risk-paths:/);
  }
});

test('glob matches are anchored and single stars stay within one segment', () => {
  const re = globToRegExp('scripts/*.mjs');
  assert.ok(re.test('scripts/gate.mjs'));
  for (const path of ['other/scripts/gate.mjs', 'scripts/sub/gate.mjs', 'scripts/gate.mjsx']) assert.ok(!re.test(path));
});

test('double stars span segments and **/ can match no directory', () => {
  assert.ok(globToRegExp('.github/**').test('.github/workflows/test.yml'));
  assert.ok(globToRegExp('.github/**').test('.github/workflows/with\nnewline.yml'));
  const re = globToRegExp('**/package.json');
  for (const path of ['package.json', 'a/package.json', 'a/b/package.json']) assert.ok(re.test(path));
  assert.ok(!re.test('packageXjson'));
});

test('glob punctuation is literal', () => {
  const literal = 'a/[b]+(c)?${x}^|.\\file';
  const re = globToRegExp(literal);
  assert.ok(re.test(literal));
  assert.ok(!re.test('a/bcfile'));
});

test('classification includes every protected path once and excludes nearby paths', () => {
  const high = ['.github/CODEOWNERS', '.github/risk-paths.yml', '.github/workflows/test.yml',
    'scripts/risk-gate.mjs', 'package.json', 'package-lock.json', '.npmrc'];
  assert.deepEqual(classify([...high, high[0], 'README.md'], config), { ci: high });
  assert.deepEqual(classify(['plugins/hmp/scripts/hook.mjs', 'test/hook.test.mjs', 'README.md',
    'scripts/other.mjs', 'package.json.bak', 'sub/package.json', '.github-backup/test.yml'], config), {});
});

test('ordinary main PRs pass without reviews or PR body sections', () => {
  for (const body of [undefined, '', '<!-- empty -->', '## テスト\n']) {
    const result = verdict({ body });
    assert.equal(result.ok, true);
    assert.equal(result.tier, 'low');
  }
});

test('CI, gate and dependency changes to main wait for approval', () => {
  for (const file of ['.github/workflows/test.yml', 'scripts/risk-gate.mjs', 'package.json', 'package-lock.json', '.npmrc']) {
    const result = verdict({ files: [file] });
    assert.equal(result.tier, 'high', file);
    assert.equal(result.ok, false, file);
  }
});

test('release is always high, including ordinary paths and an empty file list', () => {
  for (const files of [[], ['README.md'], ['plugins/hmp/scripts/hook.mjs'], ['.github/workflows/test.yml']]) {
    const result = verdict({ baseRef: 'release', files });
    assert.equal(result.tier, 'high');
    assert.equal(result.ok, false);
    assert.ok(result.lines.some(line => line.includes('release')));
  }
});

test('a listed human APPROVED review on the latest commit opens main and release gates', () => {
  const approved = review();
  for (const baseRef of ['main', 'release']) {
    const result = verdict({ baseRef, files: ['package.json'], reviews: [approved], body: '' });
    assert.equal(result.ok, true);
    assert.equal(result.tier, 'high');
    assert.equal(result.approval, approved);
  }
});

test('approval from an unlisted account or an old commit never counts', () => {
  for (const candidate of [review('APPROVED', { commit_id: oldSha }),
    review('APPROVED', { user: { login: 'someone-else', type: 'User' } })]) {
    assert.equal(ownerApproval([candidate], headSha, config.approvers), null);
    assert.equal(verdict({ baseRef: 'release', reviews: [candidate] }).ok, false);
  }
});

test('Bot type, [bot] suffix and missing human identity never count, even when listed', () => {
  for (const user of [{ login: 'Kun-132', type: 'Bot' }, { login: 'allowed[bot]', type: 'User' },
    { login: 'allowed[BOT]', type: 'User' }, { login: 'Kun-132' }, null]) {
    assert.equal(ownerApproval([review('APPROVED', { user })], headSha,
      ['Kun-132', 'allowed[bot]']), null);
  }
});

test('comments including 承認 and /approve and pending reviews never count', () => {
  for (const state of ['COMMENTED', 'PENDING']) {
    for (const body of ['承認', '承認します。', '/approve', 'APPROVED']) {
      const candidate = review(state, { body });
      assert.equal(ownerApproval([candidate], headSha, config.approvers), null);
      assert.equal(verdict({ baseRef: 'release', reviews: [candidate] }).ok, false);
    }
  }
});

test('a later CHANGES_REQUESTED or DISMISSED withdraws approval regardless of input order', () => {
  for (const state of ['CHANGES_REQUESTED', 'DISMISSED']) {
    const withdrawn = review(state, { id: 2, submitted_at: '2026-10-26T02:00:00Z' });
    assert.equal(ownerApproval([withdrawn, review()], headSha, config.approvers), null);
    assert.equal(verdict({ baseRef: 'release', reviews: [review(), withdrawn] }).ok, false);
  }
});

test('a new APPROVED review after withdrawal restores approval', () => {
  for (const state of ['CHANGES_REQUESTED', 'DISMISSED']) {
    const approved = review('APPROVED', { id: 3, submitted_at: '2026-10-26T03:00:00Z' });
    assert.equal(ownerApproval([approved, review(state)], headSha, config.approvers), approved);
  }
});

test('later comments and decisions on old commits do not replace the head approval', () => {
  const approved = review();
  const later = { id: 2, submitted_at: '2026-10-26T02:00:00Z' };
  for (const other of [review('COMMENTED', later), review('CHANGES_REQUESTED', { ...later, commit_id: oldSha }),
    review('DISMISSED', { ...later, commit_id: oldSha })]) {
    assert.equal(ownerApproval([approved, other], headSha, config.approvers), approved);
  }
});

test('the last decisive review is tracked separately for each approver, case-insensitively', () => {
  const approved = review('APPROVED', { user: { login: 'kun-132', type: 'User' } });
  const other = review('CHANGES_REQUESTED', {
    id: 2, user: { login: 'OtherOwner', type: 'User' }, submitted_at: '2026-10-26T02:00:00Z',
  });
  assert.equal(ownerApproval([other, approved], headSha, ['Kun-132', 'OtherOwner']), approved);
  const withdrawn = review('DISMISSED', {
    id: 3, user: { login: 'KUN-132', type: 'User' }, submitted_at: '2026-10-26T03:00:00Z',
  });
  assert.equal(ownerApproval([approved, other, withdrawn], headSha, ['Kun-132', 'OtherOwner']), null);
});

test('review IDs break ties when decisive reviews share the same timestamp', () => {
  assert.equal(ownerApproval([review('CHANGES_REQUESTED', { id: 2 }), review()], headSha, config.approvers), null);
});

// Run the real CLI with a synthetic GitHub API; it cannot make network requests.
function runGate({ files = [{ filename: 'README.md' }], extraFileCount = 0, reviews = [], pull = {}, status = 200,
  env = {}, args = [], input = '' } = {}) {
  const data = {
    pull: { changed_files: files.length + extraFileCount, head: { sha: headSha }, base: { ref: 'main' }, ...pull },
    files, reviews, status,
  };
  const mock = `const data = ${JSON.stringify(data)};
    data.files = [...Array.from({ length: ${extraFileCount} }, () => ({ filename: 'README.md' })), ...data.files];
    globalThis.fetch = async (url) => {
      const { pathname, searchParams } = new URL(url);
      const rows = pathname.endsWith('/files') ? data.files : pathname.endsWith('/reviews') ? data.reviews : data.pull;
      const start = (Number(searchParams.get('page')) - 1) * 100;
      return { ok: data.status === 200, status: data.status,
        json: async () => Array.isArray(rows) ? rows.slice(start, start + 100) : rows };
    };`;
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`,
    'scripts/risk-gate.mjs', ...args], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', input,
    env: { PR_NUMBER: '42', HEAD_SHA: headSha, BASE_REF: 'main', GITHUB_REPOSITORY: 'example/repo', ...env },
  });
}

test('CLI passes ordinary main changes, gates release and accepts only current approval', () => {
  assert.equal(runGate().status, 0);
  assert.equal(runGate({ env: { BASE_REF: 'release' }, pull: { base: { ref: 'release' } } }).status, 1);
  const high = { files: [{ filename: 'package.json' }] };
  assert.equal(runGate(high).status, 1);
  assert.equal(runGate({ ...high, reviews: [review()] }).status, 0);
  assert.equal(runGate({ ...high, reviews: [review('COMMENTED', { body: '/approve' })] }).status, 1);
});

test('CLI includes a renamed file’s previous risky path', () => {
  const result = runGate({ files: [{ filename: 'docs/old.yml', previous_filename: '.github/workflows/test.yml' }] });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ci:.*\.github\/workflows\/test.yml/);
});

test('CLI paginates both changed files and reviews', () => {
  const files = [...Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` })), { filename: 'package.json' }];
  const reviews = [...Array.from({ length: 100 }, () => review('COMMENTED')), review()];
  assert.equal(runGate({ files }).status, 1);
  assert.equal(runGate({ files, reviews }).status, 0);
});

test('CLI handles exactly 3000 files and fails closed above the API limit', () => {
  const files = [{ filename: 'package.json' }];
  assert.equal(runGate({ files, extraFileCount: 2999 }).status, 1);
  assert.equal(runGate({ files, extraFileCount: 2999, reviews: [review()] }).status, 0);
  const result = runGate({ files, extraFileCount: 3000, reviews: [review()] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /listed 3000 of 3001 changed files/);
});

test('CLI fails closed on incomplete file lists, API errors, or changed PR identity', () => {
  for (const [options, message] of [
    [{ pull: { changed_files: 2 } }, /listed 1 of 2/],
    [{ status: 403 }, /GitHub API.*403/],
    [{ pull: { head: { sha: oldSha } } }, /PR head or base changed/],
    [{ pull: { base: { ref: 'release' } } }, /PR head or base changed/],
    [{ env: { BASE_REF: '' } }, /BASE_REF are required/],
    [{ env: { HEAD_SHA: 'invalid' } }, /HEAD_SHA and BASE_REF are required/],
  ]) {
    const result = runGate(options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test('CLI strips control characters and escapes workflow-command percent signs', () => {
  const result = runGate({ files: [{ filename: '.github/a\n::warning::injected%0A.yml' }] });
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes('\n::warning::'));
  assert.match(result.stdout, /::error.*%250A/);
});

test('local tier mode also treats release as always high', () => {
  const low = runGate({ args: ['--tier'], input: 'README.md\n' });
  assert.equal(low.status, 0);
  assert.equal(low.stdout.trim(), 'low');
  assert.match(runGate({ args: ['--tier'], input: '.github/workflows/test.yml\n' }).stdout, /^high /);
  assert.match(runGate({ args: ['--tier'], env: { BASE_REF: 'release' } }).stdout, /^high /);
});

test('risk gate runs only trusted base code in a separate read-only target workflow', () => {
  const workflow = readFileSync(new URL('../.github/workflows/risk-gate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\n  pull_request_target:\n    types: \[opened, synchronize, reopened, edited\]/);
  assert.match(workflow, /permissions:\n  contents: read\n  pull-requests: read\njobs:/);
  assert.match(workflow, /jobs:\n  risk-gate:\n    name: risk-gate/);
  assert.match(workflow, /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.doesNotMatch(workflow, /^\s+(ref|repository|cache):/m);
  assert.doesNotMatch(workflow, /git fetch|refs\/pull\/|npm |RUNNER_TEMP|fallback/i);
  const commands = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(commands, ['node scripts/risk-gate.mjs --config .github/risk-paths.yml']);
  for (const field of ['number', 'head.sha', 'base.ref']) {
    assert.ok(workflow.includes('${{ github.event.pull_request.' + field + ' }}'));
  }
});

test('test workflow keeps only the original tests and contents read permission', () => {
  const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\n  pull_request:\n  push:/);
  assert.match(workflow, /permissions:\n  contents: read\njobs:/);
  assert.doesNotMatch(workflow, /risk-gate|GH_TOKEN|pull-requests:|pull_request_target/);
  assert.match(workflow, /run: node --test test\/\*\.test\.mjs/);
});

// Exercise the actual rerun shell with curl replaced by a local synthetic API.
// The target run has a base SHA different from the PR head and appears on page 2.
function runRerun(t, matchingRun = true) {
  const dir = mkdtempSync(join(tmpdir(), 'hmp-risk-gate-rerun-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls.jsonl');
  const curl = `#!${process.execPath}
    import { appendFileSync, readFileSync } from 'node:fs';
    readFileSync(0, 'utf8');
    const url = new URL(process.argv.at(-1));
    const method = process.argv.includes('-X') ? process.argv[process.argv.indexOf('-X') + 1] : 'GET';
    appendFileSync(process.env.CALL_LOG, JSON.stringify({ method, path: url.pathname, query: url.search }) + '\\n');
    let response;
    if (url.pathname.endsWith('/workflows/risk-gate.yml/runs')) {
      if (url.searchParams.get('event') !== 'pull_request_target' || url.searchParams.has('head_sha')) process.exit(1);
      const wrong = [
        { id: 999, status: 'completed', head_sha: '${headSha}', display_title: 'risk-gate PR #99 @ ${headSha}' },
        { id: 998, status: 'completed', head_sha: '${headSha}', display_title: 'risk-gate PR #42 @ ${oldSha}' },
      ];
      response = { workflow_runs: url.searchParams.get('page') === '1'
        ? [...wrong, ...Array.from({ length: 98 }, () => ({ display_title: 'unrelated' }))]
        : ${matchingRun} ? [{ id: 47, status: 'completed', head_sha: '${oldSha}',
            display_title: 'risk-gate PR #42 @ ${headSha}' }] : [] };
    } else if (url.pathname.endsWith('/runs/47/jobs')) {
      response = { jobs: [{ name: 'test', id: 9 }, { name: 'risk-gate', id: 10 }] };
    } else if (url.pathname.endsWith('/jobs/10/rerun') && method === 'POST') response = {};
    else process.exit(1);
    process.stdout.write(JSON.stringify(response));
  `;
  writeFileSync(join(dir, 'curl'), curl, { mode: 0o700 });
  const workflow = readFileSync(new URL('../.github/workflows/risk-gate-rerun.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /uses:|checkout/);
  const script = workflow.split('        run: |\n')[1].replace(/^          /gm, '');
  assert.doesNotMatch(script, /\$\{\{/);
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 5000,
    env: { PATH: dir + ':' + process.env.PATH, CALL_LOG: calls, GH_TOKEN: 'synthetic',
      GITHUB_API_URL: 'https://example.invalid', GITHUB_REPOSITORY: 'example/repo', PR_NUMBER: '42', HEAD_SHA: headSha },
  });
  const requests = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { result, requests };
}

test('reviews rerun only the matching target risk-gate job, with paginated run lookup', t => {
  const { result, requests } = runRerun(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Re-running job risk-gate \(10\) of run 47/);
  assert.ok(requests.some(request => request.query.includes('page=2')));
  assert.deepEqual(requests.filter(request => request.method === 'POST'),
    [{ method: 'POST', path: '/repos/example/repo/actions/jobs/10/rerun', query: '' }]);
});

test('reviews do not rerun a different PR or an old head when no matching target run exists', t => {
  const { result, requests } = runRerun(t, false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No risk-gate run for PR #42/);
  assert.ok(requests.every(request => request.method === 'GET'));
});
