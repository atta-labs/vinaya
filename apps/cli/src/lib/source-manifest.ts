/**
 * The required-source manifest and its delivery receipts — what the
 * controller prepared for a Developer turn, and what it recorded delivering.
 *
 * Both live in one controller-owned store per task,
 * `<runtimeDir>/tasks-execution/<task>/control/sources/`, beside the control
 * store's own effect and ownership records. That directory is inside neither
 * agent's writable roots (`apps/cli/specs/isolation.md`, "Required sources
 * and their receipts"): a worker can neither create, edit nor delete a file
 * here, and the dispatch refuses before spawning when a writable root would
 * reach it (`controllerStoreReachableBy`, `worker-boundary.ts`). A receipt a
 * worker fabricates anywhere it can write is therefore never read: every
 * reader in this module reads this store and nothing else.
 *
 * A manifest entry is a `PreparedSource` — the shape the `prepare_sources`
 * node contract names. A receipt is one `SourceDeliveryReceipt` line: either
 * the controller recording that it injected a repository source into the
 * Developer's prompt, or the `fetch_documentation` tool recording a page it
 * fetched for the Developer, matched to its manifest entry by normalized
 * source identity and compared against the pinned digest.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RequiredSourceMissingReason } from '@attalabs/aeg-core'
import { type RunScope, runPath } from './run-paths.js'

/** The store's directory name inside a task's `control/` area. */
export const SOURCE_STORE_DIRNAME = 'sources'

/** The manifest file inside the store — the latest prepared manifest, rewritten whole on each preparation. */
export const SOURCE_MANIFEST_FILE = 'manifest.json'

/** The receipts file inside the store — append-only, one JSON line per delivery. */
export const SOURCE_RECEIPTS_FILE = 'receipts.jsonl'

/** The directory holding each fetched page's exact bytes, named by their sha256. */
export const SOURCE_SNAPSHOTS_DIRNAME = 'snapshots'

/** How a prepared source reaches the Developer. */
export type SourceDeliveryMode = 'injected' | 'retrieval_tool' | 'unavailable'

/**
 * How a delivered revision is held to the prepared one. `pinned`: the
 * source names an immutable revision (a repository object at the frozen
 * base, or a URL carrying a full commit id), so any other revision is a
 * different source. `volatile`: the source cannot be pinned (an ordinary web
 * page), so only the exact digest the controller retrieved is recorded.
 */
export type SourceFreshnessPolicy = 'pinned' | 'volatile'

/** Who stands behind a source's content. */
export type SourceTrustClassification = 'repository' | 'public_web_untrusted'

/** One manifest entry — the `prepare_sources` node contract's `PreparedSource`. */
export type PreparedSource = {
  /** The normalized source identity every receipt and every `sourceUses` entry is matched by. */
  sourceId: string
  /** `https://…` for a page; `repository:<path>` for a repository source. */
  canonicalUri: string
  /** The source exactly as the brief's `## Documentation` line names it. */
  requirementText: string
  /** The mechanism the brief says this source governs. */
  governs: string
  /** The objectives the brief cites for it. */
  objectiveIds: number[]
  /** When the controller retrieved or pinned it. */
  retrievedAt: string
  /** The commit a repository source was pinned at, or the page's `ETag`/`Last-Modified` when it sent one. */
  versionOrRevision: string | null
  /** `sha256:<hex>` of the exact content; `null` only for an unavailable source. */
  contentDigest: string | null
  /** The page's media type, or `text/plain` for a repository file and `inode/directory` for a repository directory. */
  mediaType: string | null
  deliveryMode: SourceDeliveryMode
  /** `git:<blob|tree>:<object id>` for a repository source; `snapshot:sha256:<hex>` for a stored page. */
  snapshotRef: string | null
  freshnessPolicy: SourceFreshnessPolicy
  trustClassification: SourceTrustClassification
  /** Set only on an unavailable source: the typed reason and what was observed. */
  unavailable?: { reason: RequiredSourceMissingReason; detail: string }
}

/** The manifest the controller prepares before every Developer dispatch of a round. */
export type RequiredSourceManifest = {
  schemaVersion: 1
  round: number
  /** The frozen base revision repository sources were pinned at, `null` when the brief named none and no worktree head was readable. */
  base: string | null
  /** `sha256:<hex>` of the frozen brief text the sources were read from. */
  briefDigest: string
  preparedAt: string
  sources: PreparedSource[]
  /** `sha256:<hex>` over everything above — the identity a later reader binds to. */
  digest: string
}

/**
 * One recorded delivery. `source` repeats `sourceId` so the agents' Stop
 * hooks, which read this file only to stop nagging about a delivered
 * source, keep matching on the field they always read.
 */
export type SourceDeliveryReceipt = {
  schemaVersion: 1
  sourceId: string
  source: string
  round: number
  recordedAt: string
  mode: 'injected' | 'retrieval_tool'
  /** Who wrote it — always the controller: `controller` for an injection, `fetch_documentation` for a fetch it ran. */
  recordedBy: 'controller' | 'fetch_documentation'
  /** The digest the manifest pinned, `null` when the fetch named no manifest entry. */
  pinnedDigest: string | null
  /** `sha256:<hex>` of what was actually delivered. */
  deliveredDigest: string
  /** `match`/`mismatch` against `pinnedDigest`; `unpinned` when there was nothing to compare with. */
  revision: 'match' | 'mismatch' | 'unpinned'
  /** What `SOURCE_REVISION_POLICY` decided: a `refused` delivery never counts as delivered. */
  decision: 'counted' | 'refused'
  /** Present for a fetched page. */
  requestedUrl?: string
  finalUrl?: string
  status?: number
  contentType?: string
  size?: number
}

/**
 * What happens when a fetched revision differs from the manifest's: a
 * `pinned` source refuses the other revision — it is a different source,
 * and the delivery does not count — while a `volatile` source counts the
 * fresh revision and records the mismatch, since a live page cannot be held
 * still and the exact digest the Developer read is what the receipt keeps.
 */
export const SOURCE_REVISION_POLICY: Readonly<Record<SourceFreshnessPolicy, 'refuse' | 'count'>> = {
  pinned: 'refuse',
  volatile: 'count'
}

/** `sha256:<hex>` of `content`. */
export function sha256Digest(content: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/** The task's source store: `<runtimeDir>/tasks-execution/<task>/control/sources`. */
export function sourceStoreDir(runtimeDir: string, scope: RunScope): string {
  return runPath(runtimeDir, scope, { area: 'control', file: SOURCE_STORE_DIRNAME })
}

export function sourceManifestPath(storeDir: string): string {
  return join(storeDir, SOURCE_MANIFEST_FILE)
}

export function sourceReceiptsPath(storeDir: string): string {
  return join(storeDir, SOURCE_RECEIPTS_FILE)
}

export function sourceSnapshotPath(storeDir: string, digest: string): string {
  return join(storeDir, SOURCE_SNAPSHOTS_DIRNAME, digest.replace(/^sha256:/, ''))
}

/** The manifest's own digest — over its content, never over `digest` itself. */
export function manifestDigest(manifest: Omit<RequiredSourceManifest, 'digest'>): string {
  const { schemaVersion, round, base, briefDigest, preparedAt, sources } = manifest
  return sha256Digest(JSON.stringify({ schemaVersion, round, base, briefDigest, preparedAt, sources }))
}

function ensureStore(storeDir: string): void {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 })
  chmodSync(storeDir, 0o700)
}

/** Writes the manifest whole — to a sibling file first, renamed over the old one, so a reader never sees half of it. */
export function writeRequiredSourceManifest(storeDir: string, manifest: RequiredSourceManifest): void {
  ensureStore(storeDir)
  const path = sourceManifestPath(storeDir)
  const staged = `${path}.${process.pid}.tmp`
  writeFileSync(staged, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(staged, path)
}

/** Stores a fetched page's exact bytes once, under their digest. */
export function writeSourceSnapshot(storeDir: string, digest: string, body: Uint8Array): string {
  const path = sourceSnapshotPath(storeDir, digest)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (!existsSync(path)) writeFileSync(path, body, { mode: 0o600 })
  return `snapshot:${digest}`
}

function isPreparedSource(value: unknown): value is PreparedSource {
  if (value === null || typeof value !== 'object') return false
  const s = value as Record<string, unknown>
  return (
    typeof s.sourceId === 'string' &&
    typeof s.canonicalUri === 'string' &&
    typeof s.requirementText === 'string' &&
    typeof s.governs === 'string' &&
    (s.deliveryMode === 'injected' || s.deliveryMode === 'retrieval_tool' || s.deliveryMode === 'unavailable') &&
    (s.freshnessPolicy === 'pinned' || s.freshnessPolicy === 'volatile') &&
    (s.contentDigest === null || typeof s.contentDigest === 'string')
  )
}

/** The stored manifest, or `null` when none was prepared or the file does not hold one whose digest still matches its content. */
export function readRequiredSourceManifest(storeDir: string): RequiredSourceManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(sourceManifestPath(storeDir), 'utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const m = parsed as RequiredSourceManifest
  if (m.schemaVersion !== 1 || !Array.isArray(m.sources) || !m.sources.every(isPreparedSource)) return null
  if (typeof m.digest !== 'string' || manifestDigest(m) !== m.digest) return null
  return m
}

/** Appends one receipt line, creating the store owner-only when it is missing. */
export function appendSourceDeliveryReceipt(receiptsPath: string, receipt: SourceDeliveryReceipt): void {
  mkdirSync(dirname(receiptsPath), { recursive: true, mode: 0o700 })
  appendFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
}

/** Every well-formed receipt line in `receiptsPath`; a missing file is no receipts. */
export function readSourceDeliveryReceipts(receiptsPath: string): SourceDeliveryReceipt[] {
  let text: string
  try {
    text = readFileSync(receiptsPath, 'utf8')
  } catch {
    return []
  }
  const receipts: SourceDeliveryReceipt[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line) as SourceDeliveryReceipt
      if (r && typeof r.sourceId === 'string' && (r.decision === 'counted' || r.decision === 'refused'))
        receipts.push(r)
    } catch {
      // not a receipt line
    }
  }
  return receipts
}

/** The source identities with at least one counted delivery. */
export function countedSourceIds(receipts: readonly SourceDeliveryReceipt[]): string[] {
  return [...new Set(receipts.filter((r) => r.decision === 'counted').map((r) => r.sourceId))]
}

/** Compares a delivered digest with the manifest entry's and applies `SOURCE_REVISION_POLICY`. */
export function decideDeliveredRevision(
  entry: Pick<PreparedSource, 'contentDigest' | 'freshnessPolicy'> | null,
  deliveredDigest: string
): Pick<SourceDeliveryReceipt, 'revision' | 'decision' | 'pinnedDigest'> {
  if (entry === null || entry.contentDigest === null) {
    return { revision: 'unpinned', decision: 'counted', pinnedDigest: entry?.contentDigest ?? null }
  }
  if (entry.contentDigest === deliveredDigest) {
    return { revision: 'match', decision: 'counted', pinnedDigest: entry.contentDigest }
  }
  return {
    revision: 'mismatch',
    decision: SOURCE_REVISION_POLICY[entry.freshnessPolicy] === 'refuse' ? 'refused' : 'counted',
    pinnedDigest: entry.contentDigest
  }
}

/** The manifest entry `sourceId` names, by normalized identity. */
export function manifestEntryFor(manifest: RequiredSourceManifest | null, sourceId: string): PreparedSource | null {
  return manifest?.sources.find((s) => s.sourceId === sourceId) ?? null
}

/** The controller's receipts for the repository sources it injected into this dispatch's prompt. */
export function injectedDeliveryReceipts(
  manifest: RequiredSourceManifest,
  recordedAt: string
): SourceDeliveryReceipt[] {
  return manifest.sources
    .filter((s) => s.deliveryMode === 'injected' && s.contentDigest !== null)
    .map((s) => ({
      schemaVersion: 1 as const,
      sourceId: s.sourceId,
      source: s.sourceId,
      round: manifest.round,
      recordedAt,
      mode: 'injected' as const,
      recordedBy: 'controller' as const,
      pinnedDigest: s.contentDigest,
      deliveredDigest: s.contentDigest as string,
      revision: 'match' as const,
      decision: 'counted' as const
    }))
}

/**
 * The block every Developer prompt carries — round 1, every later round,
 * every resume and every re-ask alike — naming each required source, how it
 * is delivered and the revision the controller pinned.
 */
export function requiredSourcesPromptBlock(manifest: RequiredSourceManifest): string | null {
  if (manifest.sources.length === 0) return null
  const lines = manifest.sources.map((s) => {
    const how =
      s.deliveryMode === 'injected'
        ? `in your worktree, pinned at ${s.snapshotRef ?? 'the frozen base'}${manifest.base ? ` of ${manifest.base}` : ''}`
        : s.deliveryMode === 'retrieval_tool'
          ? `read it with \`fetch_documentation\`; the controller retrieved ${s.contentDigest ?? 'it'} (${s.freshnessPolicy})`
          : `unavailable: ${s.unavailable?.reason ?? 'unknown'}`
    return `- \`${s.sourceId}\` — governs: ${s.governs} — ${how}`
  })
  return [
    `Required sources (controller manifest ${manifest.digest}, round ${manifest.round}). The controller prepared each one before this turn and records every delivery itself; cite each in \`sourceUses\` by the identity shown:`,
    ...lines
  ].join('\n')
}
