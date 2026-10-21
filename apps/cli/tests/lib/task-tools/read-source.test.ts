/**
 * `read_source` — the code and security reviewers' read of a required
 * source: the content the controller pinned for the Developer, its final URL
 * and its digest, in bounded pages, from the controller-owned store and
 * nothing else. A page that changes after the controller pinned it is still
 * served at the pinned digest, so the Developer and both reviewers resolve
 * the same revision; reviewers get no URL fetch of their own.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { DEFAULT_REVIEW_POLICY } from '@attalabs/aeg-core'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type RequiredSourceManifest,
  readSourceDeliveryReceipts,
  requiredSourcesPromptBlock,
  sha256Digest,
  sourceReceiptsPath,
  sourceSnapshotPath,
  writeRequiredSourceManifest
} from '../../../src/lib/source-manifest.js'
import { gitObjectReader, prepareSources } from '../../../src/lib/source-provider.js'
import { dispatchDevTool, reviewerDevToolContext } from '../../../src/lib/task-tools/dev-tools-server.js'
import {
  createFetchDocumentationTool,
  type FetchDocumentationDeps,
  type FetchTarget,
  type RawResponse
} from '../../../src/lib/task-tools/fetch-documentation.js'
import {
  createReadSourceTool,
  pageEnd,
  READ_SOURCE_PAGE_BYTES,
  READ_SOURCE_TOOL,
  type ReadSourceResult
} from '../../../src/lib/task-tools/read-source.js'
import { isToolGranted, servedTools } from '../../../src/lib/task-tools/role-grants.js'
import { AGENT_TOOL_CATALOG } from '../../../src/lib/task-tools/tool-catalog.js'
import {
  driverAuthoredPromptText,
  lintReviewerPrompt,
  renderReviewerDispatchPrompt,
  requiredSourcePieces,
  type ReviewerPromptFacts,
  reviewerSourceFacts
} from '../../../src/lib/dev-review-loop/reviewer-dispatch.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix = 'read-source-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const NOW = new Date('2026-10-14T00:00:00.000Z')
const PAGE_URL = 'https://docs.example.com/hooks'
const SPEC = 'specs/isolation.md'
const PAGE_V1 = `# Hooks, first revision\n\n${'The Stop hook runs when the turn ends. '.repeat(60)}`
const PAGE_V2 = `# Hooks, second revision\n\n${'The Stop hook was renamed and now blocks. '.repeat(60)}`

/** A page server whose body the test can change between turns. */
function mutablePage(): { deps: FetchDocumentationDeps; set: (body: string) => void } {
  let body = PAGE_V1
  return {
    set: (next) => {
      body = next
    },
    deps: {
      resolve: async () => [{ address: '93.184.215.14', family: 4 }],
      request: async (target: FetchTarget): Promise<RawResponse> => {
        if (`https://${target.hostname}${target.path}` !== PAGE_URL) throw new Error('no route')
        return {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
          body: new TextEncoder().encode(body),
          framed: true
        }
      },
      now: () => NOW
    }
  }
}

/** A real repository with one committed spec, and the commit id. */
function repository(content = '# Isolation\n\nThe writable roots.\n'): { dir: string; base: string } {
  const dir = tempDir('read-source-repo-')
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(dir, 'specs'))
  writeFileSync(join(dir, SPEC), content)
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  return { dir, base: git('rev-parse', 'HEAD') }
}

function brief(...sources: string[]): string {
  return `## Objectives\n\nO1. Something.\n\n## Documentation\n\n${sources.map((s) => `- ${s} — the mechanism it governs (O1)`).join('\n')}\n\n## Premises\n`
}

/** Prepares a manifest for one page and one repository spec, as the controller does before the Developer's turn. */
async function prepared(specContent?: string) {
  const repo = repository(specContent)
  const page = mutablePage()
  const storeDir = join(tempDir(), 'control', 'sources')
  const { manifest } = await prepareSources({
    brief: brief(PAGE_URL, SPEC),
    round: 1,
    base: repo.base,
    storeDir,
    deps: { readObject: gitObjectReader(repo.dir), fetch: page.deps, now: () => NOW }
  })
  const readSource = createReadSourceTool({
    storeDir,
    manifestDigest: manifest.digest,
    readObject: gitObjectReader(repo.dir)
  })
  return { repo, page, storeDir, manifest, readSource }
}

async function read(
  tool: ReturnType<typeof createReadSourceTool>,
  sourceId: string,
  offset?: number
): Promise<ReadSourceResult> {
  const result = await tool(offset === undefined ? { sourceId } : { sourceId, offset })
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`)
  return result.result
}

describe('read_source serves the controller-pinned content of one manifest entry (O1)', () => {
  it('returns a repository source’s pinned content, its digest and no final URL', async () => {
    const { manifest, readSource } = await prepared()
    const spec = await read(readSource, SPEC)
    expect(spec.content).toBe('# Isolation\n\nThe writable roots.\n')
    expect(spec.digest).toBe(manifest.sources.find((s) => s.sourceId === SPEC)?.contentDigest as string)
    expect(spec.digest).toBe(sha256Digest(spec.content))
    expect(spec.snapshotRef).toMatch(/^git:blob:[0-9a-f]{40}$/)
    expect(spec.finalUrl).toBeNull()
    expect(spec.manifestDigest).toBe(manifest.digest)
    expect(spec.nextOffset).toBeNull()
  })

  it('returns a page’s stored snapshot with the final URL it was served from', async () => {
    const { manifest, readSource } = await prepared()
    const page = await read(readSource, PAGE_URL)
    expect(page.content).toBe(PAGE_V1)
    expect(page.finalUrl).toBe(PAGE_URL)
    expect(page.digest).toBe(manifest.sources.find((s) => s.sourceId === PAGE_URL)?.contentDigest as string)
    expect(page.snapshotRef).toBe(`snapshot:${page.digest}`)
  })

  it('pages a long source within the catalog’s size limit and names the next offset', async () => {
    const long = `${'é wide text with ünïcode ✓ '.repeat(4000)}end`
    const { readSource } = await prepared(long)
    const catalog = AGENT_TOOL_CATALOG.find((tool) => tool.name === READ_SOURCE_TOOL)
    expect(catalog?.limits.outputBytes).toBe(READ_SOURCE_PAGE_BYTES)
    let offset: number | null = 0
    let joined = ''
    let pages = 0
    while (offset !== null) {
      const page = await read(readSource, SPEC, offset)
      expect(new TextEncoder().encode(page.content).length).toBeLessThanOrEqual(READ_SOURCE_PAGE_BYTES)
      expect(page.offset).toBe(offset)
      joined += page.content
      offset = page.nextOffset
      pages += 1
    }
    expect(pages).toBeGreaterThan(1)
    expect(joined).toBe(long)
  })

  it('never splits a surrogate pair at a page boundary', () => {
    const text = `a${'😀'.repeat(10)}`
    const end = pageEnd(text, 0, 7)
    expect(end).toBe(3)
    expect(text.slice(0, end)).toBe('a😀')
  })

  it('refuses an unknown sourceId, naming the manifest’s entries', async () => {
    const { readSource } = await prepared()
    const result = await readSource({ sourceId: 'https://elsewhere.example.com/page' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatchObject({ errorClass: 'invalid_input', check: 'unknown-source' })
      expect(result.error.fix).toContain(SPEC)
    }
  })

  it('refuses an offset past the end of the content', async () => {
    const { readSource } = await prepared()
    const result = await readSource({ sourceId: SPEC, offset: 10_000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.check).toBe('offset-out-of-range')
  })

  it('refuses every read once the store holds a manifest other than the one the dispatch was bound to', async () => {
    const { storeDir, manifest, readSource } = await prepared()
    const other: RequiredSourceManifest = { ...manifest, round: 2, digest: 'sha256:other' }
    writeRequiredSourceManifest(storeDir, other)
    const result = await readSource({ sourceId: SPEC })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ errorClass: 'conflict', check: 'manifest-changed' })
  })

  it('refuses a snapshot that no longer hashes to the pinned digest rather than serving it', async () => {
    const { storeDir, manifest, readSource } = await prepared()
    const digest = manifest.sources.find((s) => s.sourceId === PAGE_URL)?.contentDigest as string
    writeFileSync(sourceSnapshotPath(storeDir, digest), 'tampered')
    const result = await readSource({ sourceId: PAGE_URL })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.check).toBe('pinned-content-mismatch')
  })

  it('refuses a repository object other than the one pinned', async () => {
    const { storeDir, manifest, repo } = await prepared()
    const tool = createReadSourceTool({
      storeDir,
      manifestDigest: manifest.digest,
      readObject: () => ({ type: 'blob', id: 'f'.repeat(40), content: new TextEncoder().encode('other') })
    })
    const result = await tool({ sourceId: SPEC })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.check).toBe('pinned-content-mismatch')
    expect(repo.base.length).toBe(40)
  })
})

describe('the Developer and both reviewers resolve the same pinned digest when the page changes (O2)', () => {
  it('serves both reviewers the revision the Developer was given, never the changed page', async () => {
    const { page, storeDir, manifest, readSource } = await prepared()
    const pinned = manifest.sources.find((s) => s.sourceId === PAGE_URL)?.contentDigest as string
    // The Developer's prompt names the pinned digest.
    expect(requiredSourcesPromptBlock(manifest)).toContain(pinned)

    // The page changes after the controller pinned it; the Developer's fetch
    // reads the new revision and its receipt still names the pinned digest.
    page.set(PAGE_V2)
    const fetch = createFetchDocumentationTool({
      receiptsPath: sourceReceiptsPath(storeDir),
      manifest: () => manifest,
      deps: page.deps
    })
    const fetched = await fetch({ url: PAGE_URL })
    expect(fetched.ok).toBe(true)
    const receipt = readSourceDeliveryReceipts(sourceReceiptsPath(storeDir)).find((r) => r.sourceId === PAGE_URL)
    expect(receipt).toMatchObject({ pinnedDigest: pinned, revision: 'mismatch' })

    // Each reviewer's own server answers at the pinned digest, with the pinned content.
    for (const role of ['code-reviewer', 'security'] as const) {
      const result = await dispatchDevTool(reviewerDevToolContext(readSource), role, READ_SOURCE_TOOL, {
        sourceId: PAGE_URL
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        const served = result.result as ReadSourceResult
        expect(served.digest).toBe(pinned)
        expect(served.content).toBe(PAGE_V1)
        expect(served.content).not.toContain('second revision')
      }
    }
  })
})

describe('the grant: reviewers read pinned sources, and fetch nothing (O1)', () => {
  it('serves each reviewer exactly read_source and the Developer never', () => {
    expect(servedTools('code-reviewer').map((t) => t.name)).toEqual([READ_SOURCE_TOOL])
    expect(servedTools('security').map((t) => t.name)).toEqual([READ_SOURCE_TOOL])
    expect(servedTools('developer').map((t) => t.name)).not.toContain(READ_SOURCE_TOOL)
    expect(isToolGranted('code-reviewer', 'fetch_documentation')).toBe(false)
    expect(isToolGranted('security', 'fetch_documentation')).toBe(false)
  })

  it('refuses a reviewer’s fetch_documentation call before any handler runs', async () => {
    const { readSource } = await prepared()
    const result = await dispatchDevTool(reviewerDevToolContext(readSource), 'code-reviewer', 'fetch_documentation', {
      url: PAGE_URL
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ errorClass: 'unauthorized', check: 'role-grant' })
  })

  it('takes no URL: the input names a manifest identity, with no field to fetch by', () => {
    const schema = AGENT_TOOL_CATALOG.find((tool) => tool.name === READ_SOURCE_TOOL)?.inputSchema as {
      properties: object
    }
    expect(Object.keys(schema.properties).sort()).toEqual(['offset', 'sourceId'])
  })

  it('validates every success value against the catalog’s strict schema', async () => {
    const { readSource } = await prepared()
    const result = await dispatchDevTool(reviewerDevToolContext(readSource), 'security', READ_SOURCE_TOOL, {
      sourceId: SPEC,
      offset: 0
    })
    expect(result.ok).toBe(true)
  })
})

describe('reviewer context carries the manifest identities and the Developer’s citations (O3, O5)', () => {
  function facts(requiredSources?: ReviewerPromptFacts['requiredSources']): ReviewerPromptFacts {
    return {
      objectives: 'O1. Something.',
      resolvedObjectives: [{ id: 'O1', text: 'Something.' }],
      rulings: [],
      ciConclusion: 'green',
      revision: 'abc',
      manifest: {
        baseSha: 'b'.repeat(40),
        headSha: 'h'.repeat(40),
        briefHash: 'sha256:brief',
        objectivesVersion: 'v1',
        rulingOrdinal: 0,
        policyDigest: 'sha256:policy'
      },
      policy: DEFAULT_REVIEW_POLICY,
      ...(requiredSources ? { requiredSources } : {})
    } as ReviewerPromptFacts
  }

  it('names the manifest digest, each source and its pinned digest, and every citation', async () => {
    const { manifest } = await prepared()
    const sources = reviewerSourceFacts(manifest, [
      { source: SPEC, use: 'kept the writable roots unchanged' },
      { source: PAGE_URL, use: 'unrelated: chose a colour' }
    ])
    const pieces = requiredSourcePieces(sources)
    const text = pieces.map((p) => ('driver' in p ? p.driver : p.fact)).join('')
    expect(text).toContain(manifest.digest)
    for (const source of manifest.sources) {
      expect(text).toContain(source.sourceId)
      expect(text).toContain(source.contentDigest as string)
    }
    expect(text).toContain('read_source')
    expect(text).toContain('kept the writable roots unchanged')
    // A delivered but irrelevant citation is shown to the reviewer, who can reject it.
    expect(text).toContain('unrelated: chose a colour')
    expect(text).toContain('a receipt proves the source was delivered, never that it was used correctly')
    // The citations are the Developer's text, held out of the driver's own wording.
    expect(driverAuthoredPromptText(pieces)).not.toContain('chose a colour')
    expect(lintReviewerPrompt(driverAuthoredPromptText(pieces))).toEqual([])
  })

  it('is rendered into both reviewers’ prompts, and says when no citation was recorded', async () => {
    const { manifest } = await prepared()
    for (const role of ['reviewer', 'security'] as const) {
      const prompt = renderReviewerDispatchPrompt(role, facts(reviewerSourceFacts(manifest, null)))
      expect(prompt).toContain(`REQUIRED SOURCES (controller manifest ${manifest.digest})`)
      expect(prompt).toContain('(none recorded)')
    }
  })

  it('adds nothing for a round with no required source', () => {
    expect(renderReviewerDispatchPrompt('reviewer', facts())).not.toContain('REQUIRED SOURCES')
    const empty = reviewerSourceFacts({ digest: 'sha256:x', sources: [] }, null)
    expect(requiredSourcePieces(empty)).toEqual([])
  })

  it('reads the manifest from the store exactly as written', async () => {
    const { storeDir, manifest } = await prepared()
    const onDisk = JSON.parse(readFileSync(join(storeDir, 'manifest.json'), 'utf8')) as RequiredSourceManifest
    expect(onDisk.digest).toBe(manifest.digest)
    expect(onDisk.sources.find((s) => s.sourceId === PAGE_URL)?.finalUrl).toBe(PAGE_URL)
  })
})

describe('a repository source id is the plain path, however the Documentation list wrote it', () => {
  it('prepares ids without backticks and read_source accepts either spelling', async () => {
    const repo = repository()
    writeFileSync(join(repo.dir, 'specs', 'other.md'), '# Other\n')
    execFileSync('git', ['add', '.'], { cwd: repo.dir })
    execFileSync('git', ['commit', '-q', '-m', 'other'], { cwd: repo.dir })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim()
    const storeDir = join(tempDir(), 'control', 'sources')
    const { manifest } = await prepareSources({
      brief: brief(`\`${SPEC}\``, 'specs/other.md', PAGE_URL),
      round: 1,
      base,
      storeDir,
      deps: { readObject: gitObjectReader(repo.dir), fetch: mutablePage().deps, now: () => NOW }
    })
    expect(manifest.sources.map((s) => s.sourceId)).toEqual([SPEC, 'specs/other.md', PAGE_URL])
    const readSource = createReadSourceTool({
      storeDir,
      manifestDigest: manifest.digest,
      readObject: gitObjectReader(repo.dir)
    })
    for (const sourceId of [SPEC, `\`${SPEC}\``, 'specs/other.md', '`specs/other.md`']) {
      const result = await readSource({ sourceId })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.result.content.length).toBeGreaterThan(0)
    }
    const page = await readSource({ sourceId: PAGE_URL })
    expect(page.ok).toBe(true)
  })
})
