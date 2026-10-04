import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  cleanBundles,
  collectPackages,
  PACKAGES,
  packageNames,
  publishRelease,
  verifyPackages,
} from '../scripts/release.mjs';

const VERSION = '1.2.3';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lapower-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'dist/packages');
  await mkdir(directory, { recursive: true });
  const names = Object.keys(PACKAGES).flatMap((id) => packageNames(VERSION, id));
  for (const name of names) await writeFile(join(directory, name), `installer contents: ${name}`);
  return { root, directory, names };
}

function githubMock({
  release = null,
  assets = [],
  failUploadAt = 0,
  corruptDigest = false,
  publishEarly = false,
} = {}) {
  const state = { release, assets, calls: [], uploads: 0 };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  async function request(url, options) {
    const { pathname, searchParams } = new URL(url);
    const method = options.method;
    state.calls.push({ method, pathname });
    if (method === 'GET' && pathname.endsWith('/releases')) return json(state.release ? [state.release] : []);
    if (method === 'POST' && pathname.endsWith('/releases')) {
      state.release = {
        id: 7,
        upload_url: 'https://uploads.github.test/assets{?name,label}',
        ...JSON.parse(options.body),
      };
      return json(state.release, 201);
    }
    if (method === 'GET' && pathname.endsWith('/releases/7/assets')) return json(state.assets);
    if (method === 'GET' && pathname.endsWith('/releases/7')) {
      if (publishEarly) state.release.draft = false;
      return json(state.release);
    }
    if (method === 'DELETE' && pathname.includes('/releases/assets/')) {
      const id = Number(pathname.split('/').at(-1));
      state.assets = state.assets.filter((asset) => asset.id !== id);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && pathname === '/assets') {
      state.uploads++;
      if (state.uploads === failUploadAt) return json({ message: 'upload failed' }, 502);
      const asset = {
        id: state.uploads + 100,
        name: searchParams.get('name'),
        size: options.body.byteLength,
        state: 'uploaded',
        digest: `sha256:${corruptDigest ? 'invalid' : createHash('sha256').update(options.body).digest('hex')}`,
      };
      state.assets.push(asset);
      return json(asset, 201);
    }
    if (method === 'PATCH' && pathname.endsWith('/releases/7')) {
      Object.assign(state.release, JSON.parse(options.body), {
        html_url: 'https://github.test/owner/repo/releases/v1.2.3',
      });
      return json(state.release);
    }
    throw new Error(`Unexpected API call: ${method} ${url}`);
  }
  return { state, request };
}

const draft = () => ({
  id: 7,
  tag_name: `v${VERSION}`,
  draft: true,
  prerelease: false,
  upload_url: 'https://uploads.github.test/assets{?name,label}',
});

async function publisher(t, mockOptions) {
  const { directory, names } = await fixture(t);
  await verifyPackages(directory, VERSION, { writeChecksums: true });
  const mock = githubMock(mockOptions);
  return {
    ...mock,
    directory,
    names,
    options: {
      directory,
      version: VERSION,
      tag: `v${VERSION}`,
      repository: 'owner/repo',
      commit: 'a'.repeat(40),
      token: 'test-token',
      apiUrl: 'https://api.github.test',
      request: mock.request,
    },
  };
}

test('complete installer set produces deterministic checksums; modified files cannot be published', async (t) => {
  const { directory, names } = await fixture(t);
  const assets = await verifyPackages(directory, VERSION, { writeChecksums: true });
  assert.equal(names.length, 7);
  assert.equal(assets.length, 8);
  const sums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  assert.equal(sums.trimEnd().split('\n').length, 7);
  for (const asset of assets.filter(({ name }) => name !== 'SHA256SUMS')) {
    const content = await readFile(join(directory, asset.name));
    assert.ok(sums.includes(`${createHash('sha256').update(content).digest('hex')}  ${asset.name}\n`));
  }
  assert.deepEqual(await verifyPackages(directory, VERSION), assets);
  await writeFile(join(directory, names[0]), 'different installer');
  await assert.rejects(verifyPackages(directory, VERSION), /SHA256SUMS/);
});

test('missing architectures, stale versions, unexpected and empty files are rejected', async (t) => {
  for (const problem of ['missing', 'stale', 'extra', 'empty']) {
    await t.test(problem, async (sub) => {
      const { directory, names } = await fixture(sub);
      if (problem === 'missing')
        await rm(
          join(
            directory,
            names.find((name) => name.includes('macos-x64')),
          ),
        );
      if (problem === 'stale') {
        await rm(join(directory, names[0]));
        await writeFile(join(directory, names[0].replace(VERSION, '1.2.2')), 'old installer');
      }
      if (problem === 'extra') await writeFile(join(directory, 'unexpected.txt'), 'unexpected');
      if (problem === 'empty') await writeFile(join(directory, names[0]), '');
      await assert.rejects(verifyPackages(directory, VERSION, { writeChecksums: true }), /七个|非空/);
    });
  }
});

test('collect native installers from workspace target directories and normalize their names', async (t) => {
  const { root, directory, names } = await fixture(t);
  for (const name of names) await rm(join(directory, name));
  for (const [id, { target, bundles }] of Object.entries(PACKAGES)) {
    const expected = packageNames(VERSION, id);
    for (const [i, bundle] of bundles.entries()) {
      const dir = join(root, 'target', target, 'release/bundle', bundle);
      await mkdir(dir, { recursive: true });
      const ext = expected[i].slice(expected[i].lastIndexOf('.'));
      const filename = bundle === 'rpm' ? `laPower-${VERSION}-1.x86_64.rpm` : `laPower_${VERSION}_arch${ext}`;
      await writeFile(join(dir, filename), `native ${id}/${bundle}`);
    }
    assert.deepEqual(await collectPackages(id, VERSION, root), expected);
  }
  assert.deepEqual((await readdir(directory)).sort(), names.sort());
  await verifyPackages(directory, VERSION, { writeChecksums: true });
  const debDir = join(root, 'target', PACKAGES['linux-x64'].target, 'release/bundle/deb');
  await writeFile(join(debDir, `second_${VERSION}_amd64.deb`), 'duplicate');
  await assert.rejects(collectPackages('linux-x64', VERSION, root), /应有一个/);
  await rm(join(debDir, `second_${VERSION}_amd64.deb`));
  await assert.rejects(collectPackages('linux-x64', '1.2.4', root), /版本与清单/);
});

test('package names reject invalid versions and target paths', () => {
  for (const version of ['1.2.3\n', '01.2.3', 'v1.2.3', '1.2.3-beta', '../1.2.3']) {
    assert.throws(() => packageNames(version, 'linux-x64'), /无效/);
  }
  for (const id of ['../linux-x64', '__proto__', 'missing']) {
    assert.throws(() => packageNames(VERSION, id), /未知/);
  }
});

test('clean cached bundles without removing Rust dependencies or other targets', async (t) => {
  const { root } = await fixture(t);
  const target = PACKAGES['linux-x64'].target;
  const release = join(root, 'target', target, 'release');
  await mkdir(join(release, 'bundle/deb'), { recursive: true });
  await mkdir(join(release, 'deps'));
  await writeFile(join(release, 'bundle/deb/old.deb'), 'cached installer');
  await writeFile(join(release, 'deps/keep.rlib'), 'cached Rust dependency');
  const otherBundle = join(root, 'target', PACKAGES['windows-x64'].target, 'release/bundle/msi');
  await mkdir(otherBundle, { recursive: true });
  await writeFile(join(otherBundle, 'keep.msi'), 'another target');
  await cleanBundles('linux-x64', root);
  assert.deepEqual(await readdir(release), ['deps']);
  assert.equal(await readFile(join(release, 'deps/keep.rlib'), 'utf8'), 'cached Rust dependency');
  assert.equal(await readFile(join(otherBundle, 'keep.msi'), 'utf8'), 'another target');
  await assert.rejects(cleanBundles('../linux-x64', root), /未知/);
});

test('publish a draft only after all eight uploaded assets pass size and digest verification', async (t) => {
  const { options, state } = await publisher(t);
  const url = await publishRelease(options);
  assert.equal(url, 'https://github.test/owner/repo/releases/v1.2.3');
  assert.equal(state.release.draft, false);
  assert.equal(state.release.prerelease, false);
  assert.equal(state.assets.length, 8);
  assert.equal(state.calls.at(-2).method, 'GET');
  assert.ok(state.calls.at(-2).pathname.endsWith('/assets'));
  assert.equal(state.calls.at(-1).method, 'PATCH');
});

test('failed uploads and remote digest corruption keep the release draft', async (t) => {
  for (const mockOptions of [{ failUploadAt: 2 }, { corruptDigest: true }]) {
    await t.test(JSON.stringify(mockOptions), async (sub) => {
      const { options, state } = await publisher(sub, mockOptions);
      await assert.rejects(publishRelease(options), /失败/);
      assert.equal(state.release.draft, true);
      assert.equal(
        state.calls.some(({ method }) => method === 'PATCH'),
        false,
      );
    });
  }
});

test('rerun replaces only the owned draft assets and then publishes', async (t) => {
  const name = packageNames(VERSION, 'linux-x64')[0];
  const { options, state } = await publisher(t, { release: draft(), assets: [{ id: 42, name }] });
  await publishRelease(options);
  assert.equal(
    state.calls.some(({ method, pathname }) => method === 'POST' && pathname.endsWith('/releases')),
    false,
  );
  assert.ok(state.calls.some(({ method, pathname }) => method === 'DELETE' && pathname.endsWith('/42')));
  assert.equal(state.assets.length, 8);
  assert.equal(state.release.draft, false);
});

test('a failed release listing never creates another draft', async (t) => {
  const { options, state } = await publisher(t);
  options.request = async (url, requestOptions) => {
    assert.equal(requestOptions.method, 'GET');
    assert.ok(new URL(url).pathname.endsWith('/releases'));
    return new Response(null, { status: 403 });
  };
  await assert.rejects(publishRelease(options), /403/);
  assert.equal(state.release, null);
});

test('draft lookup follows pagination before deciding to create a release', async (t) => {
  const { options, state, request } = await publisher(t, { release: draft() });
  const pages = [];
  options.request = async (url, requestOptions) => {
    const parsed = new URL(url);
    if (requestOptions.method === 'GET' && parsed.pathname.endsWith('/releases')) {
      const page = Number(parsed.searchParams.get('page'));
      pages.push(page);
      const items = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ tag_name: `v0.0.${i}` })) : [draft()];
      return new Response(JSON.stringify(items), { status: 200 });
    }
    return request(url, requestOptions);
  };
  await publishRelease(options);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(
    state.calls.some(({ method, pathname }) => method === 'POST' && pathname.endsWith('/releases')),
    false,
  );
});

test('already published releases and drafts with unrelated assets are never overwritten', async (t) => {
  for (const mockOptions of [
    { release: { ...draft(), draft: false } },
    { release: draft(), assets: [{ id: 42, name: 'manual-attachment.zip' }] },
    { release: draft(), publishEarly: true },
  ]) {
    await t.test(JSON.stringify(mockOptions), async (sub) => {
      const { options, state } = await publisher(sub, mockOptions);
      await assert.rejects(publishRelease(options), /不自动覆盖|人工检查/);
      assert.ok(state.calls.every(({ method }) => method === 'GET'));
    });
  }
});

test('wrong tag, missing credentials and modified checksums fail before any GitHub request', async (t) => {
  const { options, state, directory } = await publisher(t);
  await assert.rejects(publishRelease({ ...options, tag: 'v1.2.4' }), /Tag/);
  await assert.rejects(publishRelease({ ...options, token: '' }), /GITHUB_TOKEN/);
  await writeFile(join(directory, 'SHA256SUMS'), 'corrupted checksums');
  await assert.rejects(publishRelease(options), /SHA256SUMS/);
  assert.equal(state.calls.length, 0);
});
