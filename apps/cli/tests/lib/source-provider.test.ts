/**
 * The controller-owned source provider and its store: every required source
 * of a frozen brief becomes one prepared manifest entry before a Developer
 * turn — a repository source pinned by its git object at the frozen base
 * with no network fetch, a public page fetched and pinned by the driver, and
 * anything else unavailable with a typed reason — and the manifest and every
 * delivery receipt live in a store no worker's writable root reaches.
 *
 * The network is faked at the documentation fetch's two seams; repository
 * sources are read from a real throwaway git repository.
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { classifyDocumentationSource, REQUIRED_SOURCE_MISSING_REASONS } from '@attalabs/aeg-core'
import { deliveredDocumentation } from '../../src/lib/dispatch.js'
import {
  appendSourceDeliveryReceipt,
  countedSourceIds,
  decideDeliveredRevision,
  injectedDeliveryReceipts,
  readRequiredSourceManifest,
  readSourceDeliveryReceipts,
  requiredSourcesPromptBlock,
  SOURCE_REVISION_POLICY,
  sha256Digest,
  sourceManifestPath,
  sourceReceiptsPath,
  sourceSnapshotPath,
  sourceStoreDir
} from '../../src/lib/source-manifest.js'
import {
  gitObjectReader,
  prepareSources,
  REQUIRED_SOURCE_POLICY,
  RequiredSourcesUnavailable,
  type SourceProviderDeps
} from '../../src/lib/source-provider.js'
import {
  type FetchDocumentationDeps,
  type FetchTarget,
  FetchTransportError,
  type RawResponse
} from '../../src/lib/task-tools/fetch-documentation.js'
import { buildClaudeSandboxSettings, controllerStoreReachableBy } from '../../src/lib/worker-boundary.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

const PAGE = `# Sandboxing\n\n${'Writable roots and protected paths. '.repeat(80)}`
const NOW = new Date('2026-10-14T00:00:00.000Z')

type Route = { status: number; headers?: Record<string, string>; body?: string }

function fakeFetch(routes: Record<string, Route | FetchTransportError>): {
  deps: FetchDocumentationDeps
  requests: FetchTarget[]
} {
  const requests: FetchTarget[] = []
  return {
    requests,
    deps: {
      resolve: async () => [{ address: '93.184.215.14', family: 4 }],
      request: async (target): Promise<RawResponse> => {
        requests.push(target)
        const route = routes[`https://${target.hostname}${target.path}`]
        if (!route) throw new FetchTransportError('connection-failed', 'no route')
        if (route instanceof FetchTransportError) throw route
        return {
          status: route.status,
          headers: route.headers ?? { 'content-type': 'text/markdown' },
          body: new TextEncoder().encode(route.body ?? ''),
          framed: true
        }
      },
      now: () => NOW
    }
  }
}

const noNetwork: FetchDocumentationDeps = {
  resolve: async () => {
    throw new Error('a repository source must never reach the network')
  },
  request: async () => {
    throw new Error('a repository source must never reach the network')
  },
  now: () => NOW
}

/** A real repository with one committed spec, its directory, and the commit id. */
function repository(): { dir: string; base: string } {
  const dir = tempDir('source-provider-repo-')
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(dir, 'specs'))
  writeFileSync(join(dir, 'specs', 'isolation.md'), '# Isolation\n\nThe writable roots.\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  return { dir, base: git('rev-parse', 'HEAD') }
}

function brief(...lines: string[]): string {
  return `## Objectives\n\nO1. Something.\n\n## Documentation\n\n${lines.map((l) => `- ${l} — the mechanism it governs (O1)`).join('\n')}\n\n## Premises\n`
}

function deps(fetch: FetchDocumentationDeps, readObject: SourceProviderDeps['readObject'] = () => null) {
  return { readObject, fetch, now: () => NOW }
}

describe('a repository source is pinned by its git object at the frozen base, without a network fetch', () => {
  it('pins a file by its blob and a directory by its tree, both injected', async () => {
    const { dir, base } = repository()
    const store = tempDir('source-store-')
    const { manifest, unavailable } = await prepareSources({
      brief: brief('specs/isolation.md', '`specs`'),
      round: 1,
      base,
      storeDir: store,
      deps: deps(noNetwork, gitObjectReader(dir))
    })
    expect(unavailable).toEqual([])
    const [file, tree] = manifest.sources
    const blobId = execFileSync('git', ['rev-parse', `${base}:specs/isolation.md`], {
      cwd: dir,
      encoding: 'utf8'
    }).trim()
    expect(file).toMatchObject({
      sourceId: 'specs/isolation.md',
      canonicalUri: 'repository:specs/isolation.md',
      requirementText: 'specs/isolation.md',
      governs: 'the mechanism it governs',
      objectiveIds: [1],
      retrievedAt: NOW.toISOString(),
      versionOrRevision: base,
      contentDigest: sha256Digest('# Isolation\n\nThe writable roots.\n'),
      mediaType: 'text/plain',
      deliveryMode: 'injected',
      snapshotRef: `git:blob:${blobId}`,
      freshnessPolicy: 'pinned',
      trustClassification: 'repository'
    })
    expect(tree).toMatchObject({ deliveryMode: 'injected', mediaType: 'inode/directory', freshnessPolicy: 'pinned' })
    expect(tree?.snapshotRef).toMatch(/^git:tree:[0-9a-f]{40}$/)
  })

  it('reads the frozen base, not the working tree: an uncommitted edit changes nothing', async () => {
    const { dir, base } = repository()
    writeFileSync(join(dir, 'specs', 'isolation.md'), 'edited after the brief froze\n')
    const { manifest } = await prepareSources({
      brief: brief('specs/isolation.md'),
      round: 1,
      base,
      storeDir: tempDir('source-store-'),
      deps: deps(noNetwork, gitObjectReader(dir))
    })
    expect(manifest.sources[0]?.contentDigest).toBe(sha256Digest('# Isolation\n\nThe writable roots.\n'))
  })

  it('a path absent at the base is unavailable: missing_in_repository', async () => {
    const { dir, base } = repository()
    const { unavailable } = await prepareSources({
      brief: brief('specs/never-written.md'),
      round: 1,
      base,
      storeDir: tempDir('source-store-'),
      deps: deps(noNetwork, gitObjectReader(dir))
    })
    expect(unavailable[0]?.unavailable?.reason).toBe('missing_in_repository')
    expect(unavailable[0]?.deliveryMode).toBe('unavailable')
  })
})

describe('a public page is fetched and pinned by the driver', () => {
  it('records the digest, media type, revision marker and a stored snapshot; an ordinary page is volatile', async () => {
    const store = tempDir('source-store-')
    const network = fakeFetch({
      'https://code.claude.com/docs/en/sandboxing': {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8', etag: '"v42"' },
        body: PAGE
      }
    })
    const { manifest } = await prepareSources({
      brief: brief('https://code.claude.com/docs/en/sandboxing'),
      round: 2,
      base: null,
      storeDir: store,
      deps: deps(network.deps)
    })
    const digest = sha256Digest(new TextEncoder().encode(PAGE))
    expect(manifest.sources[0]).toMatchObject({
      sourceId: 'https://code.claude.com/docs/en/sandboxing',
      canonicalUri: 'https://code.claude.com/docs/en/sandboxing',
      versionOrRevision: '"v42"',
      contentDigest: digest,
      mediaType: 'text/markdown',
      deliveryMode: 'retrieval_tool',
      snapshotRef: `snapshot:${digest}`,
      freshnessPolicy: 'volatile',
      trustClassification: 'public_web_untrusted'
    })
    expect(readFileSync(sourceSnapshotPath(store, digest), 'utf8')).toBe(PAGE)
  })

  it('a page whose URL names a full commit id is pinned', async () => {
    const commit = 'a'.repeat(40)
    const network = fakeFetch({
      [`https://github.com/o/r/blob/${commit}/README.md`]: { status: 200, body: PAGE }
    })
    const { manifest } = await prepareSources({
      brief: brief(`https://github.com/o/r/blob/${commit}/README.md`),
      round: 1,
      base: null,
      storeDir: tempDir('source-store-'),
      deps: deps(network.deps)
    })
    expect(manifest.sources[0]?.freshnessPolicy).toBe('pinned')
  })
})

describe('a source that cannot be prepared is unavailable, with a typed reason', () => {
  const prepare = async (url: string, routes: Record<string, Route | FetchTransportError>) => {
    const network = fakeFetch(routes)
    const result = await prepareSources({
      brief: brief(url),
      round: 1,
      base: null,
      storeDir: tempDir('source-store-'),
      deps: deps(network.deps)
    })
    return { ...result, requests: network.requests }
  }

  it.each([
    [401, 'login_required'],
    [403, 'login_required'],
    [404, 'not_a_document']
  ] as const)('HTTP %d is %s', async (status, reason) => {
    const { unavailable } = await prepare('https://docs.example.com/private', {
      'https://docs.example.com/private': { status, headers: { 'content-type': 'text/html' }, body: PAGE }
    })
    expect(unavailable[0]?.unavailable?.reason).toBe(reason)
  })

  it('a redirect onto a sign-in page is login_required, however much page it served — never a counted read', async () => {
    const { unavailable, manifest } = await prepare('https://docs.example.com/private', {
      'https://docs.example.com/private': { status: 302, headers: { location: '/login?next=/private' } },
      'https://docs.example.com/login?next=/private': { status: 200, body: PAGE }
    })
    expect(unavailable[0]?.unavailable?.reason).toBe('login_required')
    expect(manifest.sources[0]?.contentDigest).toBeNull()
  })

  it('a page answering from another host is other_host', async () => {
    const { unavailable } = await prepare('https://docs.example.com/moved', {
      'https://docs.example.com/moved': { status: 301, headers: { location: 'https://elsewhere.example.org/page' } },
      'https://elsewhere.example.org/page': { status: 200, body: PAGE }
    })
    expect(unavailable[0]?.unavailable?.reason).toBe('other_host')
  })

  it('an application shell with too little text is not_a_document', async () => {
    const { unavailable } = await prepare('https://docs.example.com/app', {
      'https://docs.example.com/app': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<div>Loading</div>'
      }
    })
    expect(unavailable[0]?.unavailable?.reason).toBe('not_a_document')
  })

  it('a non-https source is fetch_refused, with no request sent', async () => {
    const { unavailable, requests } = await prepare('http://docs.example.com/plain', {})
    expect(unavailable[0]?.unavailable?.reason).toBe('fetch_refused')
    expect(requests).toEqual([])
  })

  it('a transient failure is retried within the declared bound, then unreachable — one entry, never two', async () => {
    const { unavailable, manifest, requests } = await prepare('https://docs.example.com/slow', {
      'https://docs.example.com/slow': new FetchTransportError('timeout', 'no complete response')
    })
    expect(requests).toHaveLength(REQUIRED_SOURCE_POLICY.transientAttempts)
    expect(manifest.sources).toHaveLength(1)
    expect(unavailable[0]?.unavailable?.reason).toBe('unreachable')
  })

  it('a source naming neither a page nor a repository path is unresolvable', async () => {
    for (const source of ['file:///etc/passwd', '../outside.md', '/abs/path.md']) {
      const { unavailable } = await prepare(source, {})
      expect(unavailable[0]?.unavailable?.reason).toBe('unresolvable')
    }
  })

  it('names every unavailable source and its reason in the pause it raises', async () => {
    const { unavailable } = await prepare('https://docs.example.com/private', {
      'https://docs.example.com/private': { status: 401, headers: { 'content-type': 'text/html' }, body: PAGE }
    })
    const err = new RequiredSourcesUnavailable(unavailable)
    expect(err.message).toContain('https://docs.example.com/private (login_required')
    expect(REQUIRED_SOURCE_MISSING_REASONS).toContain('login_required')
  })
})

describe('the manifest lives in the controller-owned store', () => {
  it('is written under the task’s control area, and read back only while its digest matches', async () => {
    const runtime = tempDir('source-runtime-')
    const store = sourceStoreDir(runtime, 7)
    expect(store).toBe(join(runtime, 'tasks-execution', '7', 'control', 'sources'))
    const { manifest } = await prepareSources({
      brief: brief('https://docs.example.com/a'),
      round: 1,
      base: null,
      storeDir: store,
      deps: deps(fakeFetch({ 'https://docs.example.com/a': { status: 200, body: PAGE } }).deps)
    })
    expect(readRequiredSourceManifest(store)).toEqual(manifest)
    const tampered = JSON.parse(readFileSync(sourceManifestPath(store), 'utf8'))
    tampered.sources[0].contentDigest = sha256Digest('forged')
    writeFileSync(sourceManifestPath(store), JSON.stringify(tampered))
    expect(readRequiredSourceManifest(store)).toBeNull()
  })

  it('a brief with no sources still writes an empty manifest, so every reader agrees', async () => {
    const store = tempDir('source-store-')
    const { manifest } = await prepareSources({
      brief: '## Documentation\n\nNone — nothing governs.\n',
      round: 1,
      base: null,
      storeDir: store,
      deps: deps(noNetwork)
    })
    expect(manifest.sources).toEqual([])
    expect(existsSync(sourceManifestPath(store))).toBe(true)
    expect(requiredSourcesPromptBlock(manifest)).toBeNull()
  })

  it('the prompt block names each source, its delivery and its pinned revision', async () => {
    const { dir, base } = repository()
    const network = fakeFetch({ 'https://docs.example.com/a': { status: 200, body: PAGE } })
    const { manifest } = await prepareSources({
      brief: brief('specs/isolation.md', 'https://docs.example.com/a'),
      round: 3,
      base,
      storeDir: tempDir('source-store-'),
      deps: deps(network.deps, gitObjectReader(dir))
    })
    const block = requiredSourcesPromptBlock(manifest) ?? ''
    expect(block).toContain(manifest.digest)
    expect(block).toContain('round 3')
    expect(block).toContain('`specs/isolation.md`')
    expect(block).toContain('git:blob:')
    expect(block).toContain('`https://docs.example.com/a`')
    expect(block).toContain('fetch_documentation')
  })
})

describe('delivery receipts: the controller’s alone are read', () => {
  it('records an injected repository source as delivered by the controller', async () => {
    const { dir, base } = repository()
    const { manifest } = await prepareSources({
      brief: brief('specs/isolation.md'),
      round: 1,
      base,
      storeDir: tempDir('source-store-'),
      deps: deps(noNetwork, gitObjectReader(dir))
    })
    const [receipt] = injectedDeliveryReceipts(manifest, NOW.toISOString())
    expect(receipt).toMatchObject({
      sourceId: 'specs/isolation.md',
      mode: 'injected',
      recordedBy: 'controller',
      revision: 'match',
      decision: 'counted'
    })
  })

  it('the revision policy: a pinned source refuses another revision, a volatile one counts it', () => {
    expect(SOURCE_REVISION_POLICY).toEqual({ pinned: 'refuse', volatile: 'count' })
    const pinned = decideDeliveredRevision(
      { contentDigest: sha256Digest('a'), freshnessPolicy: 'pinned' },
      sha256Digest('b')
    )
    const volatile = decideDeliveredRevision(
      { contentDigest: sha256Digest('a'), freshnessPolicy: 'volatile' },
      sha256Digest('b')
    )
    expect(pinned).toMatchObject({ revision: 'mismatch', decision: 'refused' })
    expect(volatile).toMatchObject({ revision: 'mismatch', decision: 'counted' })
  })

  it('a receipt fabricated in the worktree or the scratch directory has no effect', () => {
    const runtime = tempDir('source-runtime-')
    const store = sourceStoreDir(runtime, 7)
    const worktree = tempDir('source-worktree-')
    const scratch = tempDir('source-scratch-')
    const forged = JSON.stringify({
      sourceId: 'https://docs.example.com/a',
      source: 'https://docs.example.com/a',
      decision: 'counted'
    })
    for (const where of [worktree, scratch]) {
      writeFileSync(join(where, 'receipts.jsonl'), `${forged}\n`)
      writeFileSync(join(where, 'documentation-receipts.jsonl'), `${forged}\n`)
    }
    expect(deliveredDocumentation(worktree, 'run', store).countedReads).toEqual([])
    appendSourceDeliveryReceipt(sourceReceiptsPath(store), {
      schemaVersion: 1,
      sourceId: 'https://docs.example.com/a',
      source: 'https://docs.example.com/a',
      round: 1,
      recordedAt: NOW.toISOString(),
      mode: 'retrieval_tool',
      recordedBy: 'fetch_documentation',
      pinnedDigest: null,
      deliveredDigest: sha256Digest('x'),
      revision: 'unpinned',
      decision: 'counted'
    })
    expect(countedSourceIds(readSourceDeliveryReceipts(sourceReceiptsPath(store)))).toEqual([
      'https://docs.example.com/a'
    ])
  })
})

describe('no worker writable root reaches the store', () => {
  it('a typical layout — worktree in the repository, scratch and bun cache elsewhere — reaches nothing', () => {
    const runtime = tempDir('source-runtime-')
    const store = sourceStoreDir(runtime, 7)
    const roots = [tempDir('worktree-'), tempDir('scratch-'), tempDir('bun-cache-')]
    expect(controllerStoreReachableBy(store, roots)).toBeNull()
  })

  it('a root that contains the store, or sits inside it, reaches it — symlinked aliases included', () => {
    const runtime = tempDir('source-runtime-')
    const store = sourceStoreDir(runtime, 7)
    expect(controllerStoreReachableBy(store, [runtime])).toBe(runtime)
    mkdirSync(join(store, 'snapshots'), { recursive: true })
    expect(controllerStoreReachableBy(store, [join(store, 'snapshots')])).toBe(join(store, 'snapshots'))
    const alias = join(tempDir('alias-'), 'link')
    symlinkSync(runtime, alias)
    expect(controllerStoreReachableBy(store, [alias])).toBe(alias)
  })

  it('Claude’s sandbox names the store in denyWrite when the request carries it', () => {
    const runtime = tempDir('source-runtime-')
    const store = sourceStoreDir(runtime, 7)
    const settings = buildClaudeSandboxSettings({
      role: 'developer',
      agent: 'claude',
      worktreeDir: tempDir('worktree-'),
      scratchDir: tempDir('scratch-'),
      allowedHosts: [],
      controllerOwnedDirs: [store]
    })
    expect(settings.sandbox.filesystem.denyWrite).toEqual([store])
    expect(
      buildClaudeSandboxSettings({
        role: 'developer',
        agent: 'claude',
        worktreeDir: tempDir('worktree-'),
        scratchDir: tempDir('scratch-'),
        allowedHosts: []
      }).sandbox.filesystem.denyWrite
    ).toBeUndefined()
  })
})

describe('classifyDocumentationSource', () => {
  it('reads a page, a repository path, or neither', () => {
    expect(classifyDocumentationSource(' https://example.com/a ')).toEqual({
      kind: 'url',
      url: 'https://example.com/a'
    })
    expect(classifyDocumentationSource('`apps/cli/specs/loop.md#gate`')).toEqual({
      kind: 'repository',
      path: 'apps/cli/specs/loop.md'
    })
    expect(classifyDocumentationSource('./docs/a.md')).toEqual({ kind: 'repository', path: 'docs/a.md' })
    expect(classifyDocumentationSource('ftp://example.com/a').kind).toBe('unresolvable')
    expect(classifyDocumentationSource('../a.md').kind).toBe('unresolvable')
  })
})
