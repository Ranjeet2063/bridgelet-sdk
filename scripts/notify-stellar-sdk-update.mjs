/**
 * Non-blocking reminder that a newer `@stellar/stellar-sdk` exists.
 *
 * This script never upgrades anything. It reads the version npm currently
 * publishes as `latest`, compares it with the exact pin in package.json, and
 * keeps a single tracking issue up to date. Deliberately so (issue #446):
 *
 * - It writes only to one issue, found via a label, which it creates on first
 *   use and then *edits* rather than re-opening a new one each week.
 * - It performs no write at all when the published version has not changed
 *   since the last run, so the steady state is silence, not a weekly comment.
 * - Every failure path logs and exits 0. A notification must not be able to
 *   fail a build, and an unreachable registry must not produce a run of
 *   confusing issues.
 *
 * Invoked only by .github/workflows/stellar-sdk-update-notify.yml, which runs
 * it with `issues: write` and `continue-on-error: true`.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGE = '@stellar/stellar-sdk';
const LABEL = 'dependency-update';
const ISSUE_TITLE = `Newer ${PACKAGE} release available`;
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}/latest`;
const API = 'https://api.github.com';

const token = process.env.GH_TOKEN;
const repo = process.env.GH_REPO;

if (!token || !repo) {
  console.log(
    `[stellar-sdk-update] GH_TOKEN/GH_REPO not set — nothing to do. ` +
      'This script is meant to run from the scheduled workflow.',
  );
  process.exit(0);
}

const api = (path, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'bridgelet-sdk-stellar-sdk-update-notify',
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });

/** Compare two dotted numeric versions. Returns <0, 0 or >0. */
function compareVersions(a, b) {
  const parse = (v) => v.split('.').map((part) => parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function markerFor(latest) {
  return `<!-- pinned-vs-latest: ${latest} -->`;
}

function issueBody(pinned, latest) {
  return [
    markerFor(latest),
    '',
    `\`${PACKAGE}\` **${latest}** has been published on npm; this repository is`,
    `pinned to **${pinned}**.`,
    '',
    'The pin is exact on purpose (see the "Stellar SDK Version" section of',
    'README.md), so nothing has been upgraded automatically. To start the manual',
    'upgrade process:',
    '',
    `1. Set \`"${PACKAGE}": "${latest}"\` in \`package.json\` and run \`npm install\`.`,
    '2. Run the full test suite: `npm test`.',
    '3. Manually exercise account creation, claim/redemption, sweep and expiry',
    '   against **testnet**.',
    '4. Only promote to production once the testnet checks pass.',
    '',
    '_This issue is updated in place by a scheduled workflow, not re-opened._',
    '_Close it once the upgrade has been merged._',
  ].join('\n');
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const pinned = pkg.dependencies?.[PACKAGE];

  if (typeof pinned !== 'string' || /[\^~><=*|]/.test(pinned)) {
    // The blocking check (npm run check:stellar-sdk-pin) owns that failure;
    // this job stays quiet rather than piling on.
    console.log(
      `[stellar-sdk-update] "${pinned}" is not an exact pin — leaving it to ` +
        'npm run check:stellar-sdk-pin.',
    );
    return;
  }

  const registry = await fetch(REGISTRY_URL, {
    headers: { accept: 'application/json' },
  });
  if (!registry.ok) {
    console.log(
      `[stellar-sdk-update] npm registry returned ${registry.status} — skipping.`,
    );
    return;
  }
  const latest = (await registry.json())?.version;
  if (typeof latest !== 'string') {
    console.log(
      '[stellar-sdk-update] registry response had no version — skipping.',
    );
    return;
  }

  if (compareVersions(latest, pinned) <= 0) {
    console.log(
      `[stellar-sdk-update] pinned ${pinned} is up to date (npm latest ${latest}).`,
    );
    return;
  }

  const query = `repo:${repo} is:issue is:open label:${LABEL} in:title "${ISSUE_TITLE}"`;
  const found = await api(
    `/search/issues?q=${encodeURIComponent(query)}&per_page=5`,
  );
  if (!found.ok) {
    console.log(
      `[stellar-sdk-update] issue search failed (${found.status}) — skipping.`,
    );
    return;
  }
  const items = (await found.json())?.items ?? [];
  const existing = items.find((item) => item.title?.trim() === ISSUE_TITLE);

  const body = issueBody(pinned, latest);

  if (existing) {
    if (existing.body?.includes(markerFor(latest))) {
      console.log(
        `[stellar-sdk-update] #${existing.number} already tracks ${latest} — no change.`,
      );
      return;
    }
    const updated = await api(`/repos/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    console.log(
      updated.ok
        ? `[stellar-sdk-update] updated #${existing.number} to mention ${latest}.`
        : `[stellar-sdk-update] could not update #${existing.number} (${updated.status}).`,
    );
    return;
  }

  const label = await api(`/repos/${repo}/labels/${LABEL}`, { method: 'GET' });
  if (!label.ok) {
    const created = await api(`/repos/${repo}/labels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: LABEL, color: '0e8a16' }),
    });
    if (!created.ok) {
      console.log(`[stellar-sdk-update] could not create the ${LABEL} label.`);
      return;
    }
  }

  const issue = await api(`/repos/${repo}/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: ISSUE_TITLE, labels: [LABEL], body }),
  });
  console.log(
    issue.ok
      ? `[stellar-sdk-update] opened ${issue.url} for ${latest}.`
      : `[stellar-sdk-update] could not open the tracking issue (${issue.status}).`,
  );
}

try {
  await main();
} catch (error) {
  // Network hiccup, rate limit, unexpected payload — none of it is worth
  // failing over, and none of it should generate issue noise.
  console.log(`[stellar-sdk-update] skipped: ${error?.message ?? error}`);
}

process.exit(0);
