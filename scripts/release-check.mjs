import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// SemVer 2.0.0: numeric prerelease identifiers must not contain leading zeroes.
export function validateVersion(version) {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  if (typeof version !== 'string' || !pattern.test(version)) {
    throw new Error(`Invalid package SemVer: ${JSON.stringify(version)}`);
  }
  return version;
}

export function releasePlan(current, previous, initial = false) {
  const version = validateVersion(current);
  if (!initial) validateVersion(previous);
  return { changed: initial || version !== previous, version, tag: `v${version}`, prerelease: version.split('+')[0].includes('-') };
}

export async function githubJson(path, { token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

export async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid GITHUB_REPOSITORY');
  const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if ((manual ? process.env.GITHUB_REF : event.ref) !== 'refs/heads/main' || event.deleted) throw new Error('Release checks require main');
  const before = event.before;
  if (!manual && !/^[0-9a-f]{40}$/.test(before || '')) throw new Error('Invalid push.before SHA');
  const current = JSON.parse(await readFile('package.json', 'utf8')).version;
  // Manual main runs bootstrap/retry a missing current-version release, while
  // the existing-release guard below keeps publication idempotent.
  const initial = manual || /^0{40}$/.test(before);
  let previous;
  if (!initial) {
    const file = await githubJson(`/repos/${repository}/contents/package.json?ref=${before}`);
    if (!file || file.encoding !== 'base64') throw new Error('Previous package.json unavailable; refusing an ambiguous release');
    previous = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')).version;
  }
  const plan = releasePlan(current, previous, initial);
  if (plan.changed) {
    const release = await githubJson(`/repos/${repository}/releases/tags/${encodeURIComponent(plan.tag)}`);
    if (release) {
      if (release.draft) throw new Error(`Existing draft release ${plan.tag} requires manual review`);
      plan.changed = false;
      console.log(`Release ${plan.tag} already exists; skip duplicate publication.`);
    } else {
      const tag = await githubJson(`/repos/${repository}/git/ref/tags/${encodeURIComponent(plan.tag)}`);
      if (tag) throw new Error(`Tag ${plan.tag} already exists without a published release; inspect it before retrying`);
    }
  }
  console.log(JSON.stringify(plan));
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(plan).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
