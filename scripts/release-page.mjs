import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubJson } from './release-check.mjs';

export function pageData(repository, releases, now = new Date()) {
  const published = releases.filter(release => !release.draft).map(release => ({
    tag: release.tag_name,
    name: release.name || release.tag_name,
    version: release.tag_name.replace(/^v/, ''),
    url: release.html_url,
    publishedAt: release.published_at,
    prerelease: Boolean(release.prerelease),
    body: release.body || '',
    assets: (release.assets || []).map(asset => ({ name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest || null })),
  })).sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  return { repository, generatedAt: now.toISOString(), latest: published.find(release => !release.prerelease) || published[0] || null, releases: published };
}

export async function main() {
  const repository = process.env.GITHUB_REPOSITORY || 'CherryLover/dsh-trace';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GITHUB_REPOSITORY');
  const releases = [];
  for (let page = 1; ; page++) {
    const batch = await githubJson(`/repos/${repository}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Expected GitHub releases array');
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const destination = process.argv[2] || 'docs/releases.json';
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(pageData(repository, releases), null, 2)}\n`);
  console.log(`Wrote ${releases.length} release records to ${destination}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
