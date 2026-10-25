/**
 * The controller-owned source provider: before a Developer turn starts,
 * every required source the frozen brief's `## Documentation` names becomes
 * one `PreparedSource` in the run's manifest (`source-manifest.ts`).
 *
 * - **A repository source** is pinned by its git object — blob or tree — at
 *   the frozen base, read straight from the object database with no network
 *   fetch. Its delivery is `injected`: the worktree already holds it, and the
 *   prompt names the exact object the controller pinned.
 * - **A public page** is fetched by the driver itself, outside every sandbox,
 *   through the same guarded fetch `fetch_documentation` uses
 *   (`fetchDocumentationPage`), and its exact bytes are stored as a snapshot.
 *   A URL that names a full commit id is `pinned`; any other page cannot be
 *   held still and is `volatile`, recorded with its exact retrieved digest.
 *   Its delivery is `retrieval_tool`: the Developer reads it through
 *   `fetch_documentation`, which records the delivery against this entry.
 * - **Anything else** is `unavailable`, with a typed reason
 *   (`RequiredSourceMissingReason`). A page behind a login is never read as
 *   if it were the document: a credential challenge or a sign-in redirect is
 *   `login_required`, whatever the size of the page it served.
 *
 * Preparation never throws for a source: each failure is that source's typed
 * outcome, and the caller pauses the run when any required source is
 * unavailable (`REQUIRED_SOURCE_POLICY`), so a turn never starts on model
 * memory in a missing source's place. A repository that cannot be read at
 * all — a worktree that does not exist, a git that fails — is no source's
 * outcome: the reader throws `SourceReaderUnavailable`, an infrastructure stop.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  classifyDocumentationSource,
  parseIssueDocumentation,
  type RequiredSourceMissingReason
} from '@attalabs/aeg-core'
import {
  manifestDigest,
  type PreparedSource,
  type RequiredSourceManifest,
  sha256Digest,
  writeRequiredSourceManifest,
  writeSourceSnapshot
} from './source-manifest.js'
import {
  documentationSourceId,
  type FetchDocumentationDeps,
  fetchDocumentationPage,
  realFetchDocumentationDeps,
  whyNotCountedAsRead
} from './task-tools/fetch-documentation.js'

/**
 * The declared policy for a required source the provider cannot prepare: a
 * transient failure is retried up to `transientAttempts` times in all,
 * keyed by source identity so a retry never yields two manifest entries;
 * a source still unavailable after that pauses the run (`missing_source`).
 */
export const REQUIRED_SOURCE_POLICY = {
  transientAttempts: 2,
  onUnavailable: 'pause'
} as const

/** One git object at a revision, as the provider pins it. */
export type RepositoryObject = { type: 'blob' | 'tree'; id: string; content: Uint8Array }

export type SourceProviderDeps = {
  /**
   * The object `path` names at `revision`, or `null` when the revision holds no such path; throws
   * `SourceReaderUnavailable` when the repository cannot be read at all. Never touches the network.
   */
  readObject: (revision: string, path: string) => RepositoryObject | null
  fetch: FetchDocumentationDeps
  now: () => Date
}

/**
 * Thrown when the repository sources are read from cannot be read at all: the worktree is missing, or git itself
 * failed. An infrastructure stop, never a source the brief named wrongly.
 */
export class SourceReaderUnavailable extends Error {
  constructor(
    readonly cwd: string,
    why: string
  ) {
    super(`the repository sources are read from cannot be read (${cwd}): ${why}`)
    this.name = 'SourceReaderUnavailable'
  }
}

/** `git rev-parse --verify --quiet`'s own answer for a revision that holds no such path. */
const NOT_FOUND_EXIT = 1

/** The real object reader: `git rev-parse`/`cat-file` against the repository `cwd` belongs to. */
export function gitObjectReader(cwd: string): SourceProviderDeps['readObject'] {
  const git = (args: string[]): Buffer => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  return (revision, path) => {
    if (!existsSync(cwd)) throw new SourceReaderUnavailable(cwd, 'the worktree does not exist')
    const spec = `${revision}:${path.replace(/\/+$/, '')}`
    let id: string
    let type: string
    try {
      id = git(['rev-parse', '--verify', '--quiet', spec]).toString('utf8').trim()
    } catch (error) {
      // Only the quiet verify's own exit means the path is absent; any other failure is git's, not the source's.
      if ((error as { status?: unknown }).status === NOT_FOUND_EXIT) return null
      throw new SourceReaderUnavailable(cwd, gitFailure(error))
    }
    try {
      type = git(['cat-file', '-t', id]).toString('utf8').trim()
    } catch (error) {
      throw new SourceReaderUnavailable(cwd, gitFailure(error))
    }
    if (type === 'blob') return { type: 'blob', id, content: new Uint8Array(git(['cat-file', 'blob', id])) }
    if (type === 'tree') return { type: 'tree', id, content: new Uint8Array(git(['ls-tree', id])) }
    return null
  }
}

/** A failed git call's first line of stderr, else its message. */
function gitFailure(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr
  const text = stderr instanceof Uint8Array ? Buffer.from(stderr).toString('utf8').trim() : ''
  return text.split('\n')[0] || (error instanceof Error ? error.message : String(error))
}

export type PrepareSourcesInput = {
  /** The frozen brief text — the only place required sources are read from. */
  brief: string
  round: number
  /** The revision repository sources are pinned at. */
  base: string | null
  /** The controller-owned store the manifest and snapshots are written to. */
  storeDir: string
  deps: SourceProviderDeps
}

export type PrepareSourcesResult = {
  manifest: RequiredSourceManifest
  /** The entries whose `deliveryMode` is `unavailable` — non-empty means the run must pause. */
  unavailable: PreparedSource[]
}

/** A full 40- or 64-hex commit id in the URL's path: the page names one immutable revision. */
const IMMUTABLE_REVISION_RE = /\/(?:blob|tree|raw|commit|blame)\/[0-9a-f]{40}(?:[0-9a-f]{24})?(?:\/|$)/i

/** A sign-in page's own address: its host or path names a login step. */
const SIGN_IN_RE = /(^|[./-])(login|signin|sign-in|sign_in|sso|auth|oauth|authorize|accounts)([./?#-]|$)/i

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function looksLikeSignIn(url: string): boolean {
  try {
    const u = new URL(url)
    return SIGN_IN_RE.test(u.hostname) || SIGN_IN_RE.test(u.pathname)
  } catch {
    return false
  }
}

type Base = Pick<PreparedSource, 'sourceId' | 'requirementText' | 'governs' | 'objectiveIds'>

function unavailable(
  base: Base,
  canonicalUri: string,
  retrievedAt: string,
  trust: PreparedSource['trustClassification'],
  reason: RequiredSourceMissingReason,
  detail: string
): PreparedSource {
  return {
    ...base,
    canonicalUri,
    retrievedAt,
    versionOrRevision: null,
    contentDigest: null,
    mediaType: null,
    deliveryMode: 'unavailable',
    snapshotRef: null,
    freshnessPolicy: 'volatile',
    trustClassification: trust,
    unavailable: { reason, detail }
  }
}

function prepareRepositorySource(
  base: Base,
  path: string,
  revision: string | null,
  deps: SourceProviderDeps
): PreparedSource {
  const retrievedAt = deps.now().toISOString()
  const canonicalUri = `repository:${path}`
  if (revision === null) {
    return unavailable(
      base,
      canonicalUri,
      retrievedAt,
      'repository',
      'missing_in_repository',
      'no frozen base revision was resolvable to pin it at'
    )
  }
  const object = deps.readObject(revision, path)
  if (object === null) {
    return unavailable(
      base,
      canonicalUri,
      retrievedAt,
      'repository',
      'missing_in_repository',
      `\`${path}\` does not exist at ${revision}`
    )
  }
  return {
    ...base,
    canonicalUri,
    retrievedAt,
    versionOrRevision: revision,
    contentDigest: sha256Digest(object.content),
    mediaType: object.type === 'blob' ? 'text/plain' : 'inode/directory',
    deliveryMode: 'injected',
    snapshotRef: `git:${object.type}:${object.id}`,
    freshnessPolicy: 'pinned',
    trustClassification: 'repository'
  }
}

async function preparePageSource(
  base: Base,
  url: string,
  storeDir: string,
  deps: SourceProviderDeps
): Promise<PreparedSource> {
  const canonicalUri = documentationSourceId(url)
  let last: PreparedSource | null = null
  for (let attempt = 1; attempt <= REQUIRED_SOURCE_POLICY.transientAttempts; attempt++) {
    const retrievedAt = deps.now().toISOString()
    const fetched = await fetchDocumentationPage(url, deps.fetch)
    if (!fetched.ok) {
      const transient = fetched.error.errorClass === 'timeout' || fetched.error.errorClass === 'dependency_unavailable'
      last = unavailable(
        base,
        canonicalUri,
        retrievedAt,
        'public_web_untrusted',
        transient ? 'unreachable' : 'fetch_refused',
        `${fetched.error.check}: ${fetched.error.output}`
      )
      if (transient) continue
      return last
    }
    const doc = fetched.document
    const requestedHost = hostOf(doc.requestedUrl)
    const finalHost = hostOf(doc.finalUrl)
    // A credential challenge, or a redirect onto a sign-in page, is a private
    // source — never a counted read, however much page it served.
    if (doc.status === 401 || doc.status === 403 || doc.status === 407) {
      return unavailable(
        base,
        canonicalUri,
        retrievedAt,
        'public_web_untrusted',
        'login_required',
        `the page answered HTTP ${doc.status}`
      )
    }
    if (doc.finalUrl !== doc.requestedUrl && looksLikeSignIn(doc.finalUrl) && !looksLikeSignIn(doc.requestedUrl)) {
      return unavailable(
        base,
        canonicalUri,
        retrievedAt,
        'public_web_untrusted',
        'login_required',
        `the page redirected to a sign-in page (${doc.finalUrl})`
      )
    }
    if (requestedHost !== finalHost) {
      return unavailable(
        base,
        canonicalUri,
        retrievedAt,
        'public_web_untrusted',
        'other_host',
        `the page answered from ${finalHost ?? doc.finalUrl}, not ${requestedHost ?? doc.requestedUrl}`
      )
    }
    const notRead = whyNotCountedAsRead(doc)
    if (notRead !== null) {
      return unavailable(base, canonicalUri, retrievedAt, 'public_web_untrusted', 'not_a_document', notRead)
    }
    const digest = sha256Digest(doc.body)
    return {
      ...base,
      canonicalUri,
      finalUrl: doc.finalUrl,
      retrievedAt,
      versionOrRevision: doc.revision ?? null,
      contentDigest: digest,
      mediaType: (doc.contentType.split(';')[0] ?? '').trim().toLowerCase() || null,
      deliveryMode: 'retrieval_tool',
      snapshotRef: writeSourceSnapshot(storeDir, digest, doc.body),
      freshnessPolicy: IMMUTABLE_REVISION_RE.test(new URL(doc.finalUrl).pathname) ? 'pinned' : 'volatile',
      trustClassification: 'public_web_untrusted'
    }
  }
  return last as PreparedSource
}

/**
 * Prepares every required source of `brief` into a manifest, writes it to
 * the controller-owned store, and returns it with its unavailable entries. A
 * brief with no `## Documentation` sources (or the `None` sentinel) yields an
 * empty manifest, still written, so every reader sees the same answer.
 */
export async function prepareSources(input: PrepareSourcesInput): Promise<PrepareSourcesResult> {
  const parsed = parseIssueDocumentation(input.brief)
  const declared = parsed.ok && parsed.value.kind === 'sources' ? parsed.value.sources : []
  const sources: PreparedSource[] = []
  const seen = new Set<string>()
  for (const entry of declared) {
    const locator = classifyDocumentationSource(entry.source)
    // A repository source's id is the path its location is read from, without
    // the code-span backticks the Documentation list wraps it in.
    const sourceId = locator.kind === 'repository' ? locator.path : documentationSourceId(entry.source)
    if (seen.has(sourceId)) continue
    seen.add(sourceId)
    const base: Base = {
      sourceId,
      requirementText: entry.source,
      governs: entry.mechanism,
      objectiveIds: entry.objectiveIds
    }
    if (locator.kind === 'url') {
      sources.push(await preparePageSource(base, locator.url, input.storeDir, input.deps))
    } else if (locator.kind === 'repository') {
      sources.push(prepareRepositorySource(base, locator.path, input.base, input.deps))
    } else {
      sources.push(
        unavailable(base, sourceId, input.deps.now().toISOString(), 'repository', 'unresolvable', locator.detail)
      )
    }
  }
  const body = {
    schemaVersion: 1 as const,
    round: input.round,
    base: input.base,
    briefDigest: sha256Digest(input.brief),
    preparedAt: input.deps.now().toISOString(),
    sources
  }
  const manifest: RequiredSourceManifest = { ...body, digest: manifestDigest(body) }
  writeRequiredSourceManifest(input.storeDir, manifest)
  return { manifest, unavailable: sources.filter((s) => s.deliveryMode === 'unavailable') }
}

/** The real dependencies: the repository at `cwd`, the guarded documentation fetch, and the clock. */
export function realSourceProviderDeps(
  cwd: string,
  fetch: FetchDocumentationDeps = realFetchDocumentationDeps
): SourceProviderDeps {
  return { readObject: gitObjectReader(cwd), fetch, now: () => new Date() }
}

/**
 * Thrown before a Developer turn when a required source is unavailable. The
 * loop turns it into a decided `missing_source` pause, never an
 * infrastructure crash, and never dispatches the turn.
 */
export class RequiredSourcesUnavailable extends Error {
  constructor(readonly sources: readonly PreparedSource[]) {
    super(
      `required source(s) could not be prepared, so the Developer turn did not start: ${sources
        .map((s) => `${s.sourceId} (${s.unavailable?.reason ?? 'unknown'}: ${s.unavailable?.detail ?? ''})`)
        .join('; ')}`
    )
    this.name = 'RequiredSourcesUnavailable'
  }
}
