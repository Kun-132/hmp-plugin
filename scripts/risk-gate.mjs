#!/usr/bin/env node
// Independent required `risk-gate` job (pull_request_target). release always needs approval; other PRs need it
// only for paths in risk-paths.yml. Only a human approver's APPROVED review on the head
// commit counts. Per approver, the last decisive review wins; comments never approve.
// Self-contained (node: built-ins only) so CI can run the base branch's copy against a PR.
// CI: node scripts/risk-gate.mjs [--config .github/risk-paths.yml]
//     (GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, BASE_REF)
// Local: git diff --name-only origin/main... | node scripts/risk-gate.mjs --tier
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Parses the small YAML subset: {approvers: string[], high: {category: string[]}}. */
export function parseConfig(text) {
  const config = { approvers: [], high: {} };
  let top = null, category = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length, body = line.trim();
    if (indent === 0) { top = body.replace(/:$/, ''); category = null; continue; }
    const item = body.startsWith('- ') ? body.slice(2).trim().replace(/^(['"])(.*)\1$/, '$2') : null;
    if (top === 'approvers' && item) config.approvers.push(item);
    else if (top === 'high' && !item && body.endsWith(':')) config.high[category = body.slice(0, -1)] = [];
    else if (top === 'high' && item && category) config.high[category].push(item);
    else throw new Error(`risk-paths: cannot read line "${raw.trim()}"`);
  }
  if (!config.approvers.length || !Object.values(config.high).some((p) => p.length)) throw new Error('risk-paths: approvers and high paths are required');
  return config;
}

/** `*` = within one segment, `**` = across segments; everything else literal. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:[\\s\\S]*/)?' : '[\\s\\S]*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** {category: [files]} for high-risk paths; empty = no high-risk paths. */
export function classify(files, config) {
  const hits = {};
  for (const [category, globs] of Object.entries(config.high)) {
    const res = globs.map(globToRegExp);
    const matched = [...new Set(files)].filter((f) => res.some((re) => re.test(f)));
    if (matched.length) hits[category] = matched;
  }
  return hits;
}

/** A human approver whose last decisive review on the head commit is APPROVED, or null. */
export function ownerApproval(reviews, headSha, approvers) {
  const allowed = new Set(approvers.map((a) => a.toLowerCase()));
  const decisive = reviews
    .filter((r) => r.user?.type === 'User' && !/\[bot\]$/i.test(r.user.login)
      && allowed.has(String(r.user.login).toLowerCase()) && r.commit_id === headSha)
    .filter((r) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)) || (a.id ?? 0) - (b.id ?? 0));
  const lastByApprover = new Map();
  for (const review of decisive) lastByApprover.set(review.user.login.toLowerCase(), review);
  return [...lastByApprover.values()].findLast((r) => r.state === 'APPROVED') ?? null;
}

/** Whole verdict; lines are Markdown for the step summary. PR body is deliberately irrelevant. */
export function judge({ files, reviews, headSha, baseRef, config }) {
  const hits = classify(files, config);
  const tier = baseRef === 'release' || Object.keys(hits).length ? 'high' : 'low';
  const approval = tier === 'high' ? ownerApproval(reviews, headSha, config.approvers) : null;
  const lines = [`### リスクの段階：${tier === 'high' ? '高（本人の承認が要る）' : '低（CI 通過で自動マージ）'}`];
  if (baseRef === 'release') lines.push('- release への変更は配布先 p1〜p3 に届くため、常に承認が要ります。');
  for (const [category, matched] of Object.entries(hits)) lines.push(`- ${category}: ${matched.map((f) => `\`${f}\``).join(', ')}`);
  if (tier === 'high') lines.push(approval
    ? `- 承認：${approval.user.login}（APPROVED、コミット ${headSha.slice(0, 7)}）`
    : `- 承認待ち：${config.approvers.join('・')} が最新のコミット ${headSha.slice(0, 7)} に APPROVED レビューを付けるまで止まります。`);
  return { ok: tier === 'low' || !!approval, tier, hits, approval, lines };
}

async function api(path, limit = Infinity) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}${sep}per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    out.push(...data);
    if (data.length < 100 || out.length >= limit) return out;
  }
}

async function main(argv) {
  const at = argv.indexOf('--config');
  const config = parseConfig(readFileSync(at >= 0 ? argv[at + 1] : '.github/risk-paths.yml', 'utf8'));
  const { PR_NUMBER: pr, HEAD_SHA: headSha, BASE_REF: baseRef } = process.env;
  if (argv.includes('--tier')) {
    const files = readFileSync(0, 'utf8').split('\n').map((f) => f.trim()).filter(Boolean);
    const hits = classify(files, config);
    console.log(baseRef === 'release' || Object.keys(hits).length ? `high ${JSON.stringify(hits)}` : 'low');
    return 0;
  }
  if (!/^\d+$/.test(pr ?? '') || !/^[0-9a-f]{40}$/.test(headSha ?? '') || !baseRef) throw new Error('PR_NUMBER, HEAD_SHA and BASE_REF are required');
  const [pull, fileRows, reviews] = await Promise.all([api(`pulls/${pr}`), api(`pulls/${pr}/files`, 3000), api(`pulls/${pr}/reviews`)]);
  // A stale run must not judge a newer head or a retargeted PR with its old event's identity.
  if (pull.head.sha !== headSha || pull.base.ref !== baseRef) throw new Error('PR head or base changed; run test for the latest PR state');
  // The files endpoint stops at 3000: an incomplete list could hide a risky file, so fail closed.
  if (fileRows.length !== pull.changed_files) throw new Error(`listed ${fileRows.length} of ${pull.changed_files} changed files; split the PR`);
  // A rename out of a risky path counts. Match real names, but drop controls from printed output
  // so a filename cannot introduce a ::workflow-command:: line.
  const files = fileRows.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  const verdict = judge({ files, reviews, headSha, baseRef, config });
  const clean = (line) => line.replace(/[\u0000-\u001f\u007f]/g, ' ');
  const summary = verdict.lines.map(clean).join('\n') + '\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!verdict.ok) console.log(`::error title=本人の承認待ち::${verdict.lines.slice(1).map(clean).join(' / ').replace(/%/g, '%25')}`);
  return verdict.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Fail closed: an error keeps the PR from merging.
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(`risk-gate: ${error.message}`); process.exit(1); });
}
