import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVersion, releasePlan, githubJson, main as checkRelease } from './release-check.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageData } from './release-page.mjs';

test('SemVer accepts release, prerelease and build identifiers', () => {
  for (const version of ['0.5.1', '1.0.0', '2.3.4-rc.1', '1.2.3-alpha-1+build.007', '1.2.3+001']) {
    assert.equal(validateVersion(version), version);
  }
});

test('SemVer rejects malformed values and leading-zero numeric identifiers', () => {
  for (const version of ['', null, 123, 'v0.5.1', '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3-01', '1.2.3-rc.01', '1.2.3-', '1.2.3+', '1.2.3\n', '1.2.3-..']) {
    assert.throws(() => validateVersion(version), /Invalid package SemVer/);
  }
});

test('initial root push releases current 0.5.1 without a previous package', () => {
  assert.deepEqual(releasePlan('0.5.1', undefined, true), { changed: true, version: '0.5.1', tag: 'v0.5.1', prerelease: false });
});

test('only a version change releases, including explicit prerelease versions', () => {
  assert.equal(releasePlan('0.5.1', '0.5.1').changed, false);
  assert.equal(releasePlan('0.5.2', '0.5.1').changed, true);
  assert.equal(releasePlan('0.6.0-rc.1+build.9', '0.5.1').prerelease, true);
  assert.equal(releasePlan('0.6.0+build-alpha', '0.5.1').prerelease, false);
  assert.throws(() => releasePlan('0.5.1', undefined));
});

test('API distinguishes missing records from authentication and server failures', async () => {
  assert.equal(await githubJson('/missing', { fetchImpl: async () => new Response('', { status: 404 }) }), null);
  assert.deepEqual(await githubJson('/ok', { fetchImpl: async () => new Response('{"ok":true}') }), { ok: true });
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(githubJson('/error', { fetchImpl: async () => new Response('error', { status }) }), new RegExp(`GitHub API ${status}`));
  }
});

test('page catalog excludes drafts, sorts, picks latest stable, maps downloadable assets', () => {
  const releases = [
    { tag_name: 'v0.5.1', html_url: 'https://example.test/stable', published_at: '2026-01-01', assets: [{ name: 'pkg.tgz', browser_download_url: 'https://example.test/pkg.tgz', size: 42, digest: 'sha256:abc' }] },
    { tag_name: 'v0.6.0-rc.1', published_at: '2026-01-02', prerelease: true },
    { tag_name: 'v9.0.0', draft: true },
  ];
  const result = pageData('CherryLover/dsh-trace', releases, new Date('2026-01-03T00:00:00Z'));
  assert.equal(result.generatedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(result.releases.length, 2);
  assert.equal(result.releases[0].version, '0.6.0-rc.1');
  assert.equal(result.latest.tag, 'v0.5.1');
  assert.deepEqual(result.latest.assets[0], { name: 'pkg.tgz', url: 'https://example.test/pkg.tgz', size: 42, digest: 'sha256:abc' });
});

test('manual main bootstrap is idempotent and rejects non-main dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-check-'));
  const keys = ['GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY', 'GITHUB_OUTPUT'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  try {
    await writeFile(join(directory, 'event.json'), '{}');
    Object.assign(process.env, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: join(directory, 'event.json'), GITHUB_REPOSITORY: 'CherryLover/dsh-trace' });
    delete process.env.GITHUB_OUTPUT;
    globalThis.fetch = async () => new Response('', { status: 404 });
    assert.equal((await checkRelease()).changed, true);
    globalThis.fetch = async () => new Response('{"draft":false}');
    assert.equal((await checkRelease()).changed, false);
    process.env.GITHUB_REF = 'refs/heads/feature';
    await assert.rejects(checkRelease(), /require main/);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('page catalog supports empty repositories and prerelease-only repositories', () => {
  assert.equal(pageData('owner/repo', []).latest, null);
  assert.equal(pageData('owner/repo', [{ tag_name: 'v1.0.0-rc.1', prerelease: true }]).latest.version, '1.0.0-rc.1');
});
