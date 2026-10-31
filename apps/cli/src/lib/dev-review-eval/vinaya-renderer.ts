/**
 * The Vinaya renderer: the two-way mapping between a layer-`G` neutral case
 * and the Vinaya process, so the generic graders can judge a Vinaya trial
 * without reading any Vinaya artifact themselves.
 *
 *  - `renderCase(case)` turns a neutral case into Vinaya process input: a
 *    frozen brief whose `## Surface` comes from the authorized scope (an
 *    `answer` case, which changes nothing, has none), whose
 *    `## Documentation` comes from the relevant delivered documents and whose
 *    one objective is the task statement, plus the source manifest and each
 *    dispatched role's tool grant, derived from the granted capabilities. A
 *    case the Vinaya process cannot express is refused, naming the field.
 *  - `extractOutcomes(record)` turns what the harness recorded about one
 *    Vinaya trial into the nine neutral outcomes. A fact the record does not
 *    carry is `unavailable`, one it records as missing is `absent`, and one
 *    that is malformed is `invalid` — never a passing value.
 *
 * Two tables carry every name translation: `TOOL_CAPABILITIES` (a trace's tool
 * name to a neutral capability) and `SEVERITY_BLOCKING` (a reviewer severity
 * to `blocking`). `VINAYA_RENDERER_VERSION` is a digest over both tables and
 * every mapping function, so any change to the mapping changes the version
 * that each process input and trial record carries.
 *
 * The renderer imports the generic graders' types and never the reverse, so a
 * change here cannot move a grader's logic digest.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type IssueSurface, recordedBeyondSurfacePaths } from '@attalabs/aeg-core'
import { parseDeveloperTurnResult } from '../developer-turn-result'
import { parseReviewResult, REVIEWER_ROLES, REVIEWER_SEVERITIES, type ReviewerRole } from '../review-result'
import type { SourceDeliveryReceipt } from '../source-manifest'
import { type GrantedRole, ROLE_TOOL_GRANTS } from '../task-tools/role-grants'
import { AGENT_TOOL_CATALOG } from '../task-tools/tool-catalog'
import type { Digest } from './contracts'
import {
  canonicalJson,
  type ChangeIdentity,
  intentVersion,
  type NeutralCase,
  type NeutralCaseKind,
  NEUTRAL_CASE_KINDS,
  neutralCaseDigest,
  validateNeutralCase
} from './neutral-case'
import type { CheckResult, Fact, NeutralOutcomes, Review, SourceReceipt, TestResult } from './neutral-outcomes'

// ── Mapping tables ──────────────────────────────────────────────────────────

/**
 * The one table from a trace's tool name to the neutral capability it
 * exercises. A trace names a driver-run tool by its catalog name, a shell
 * command as `shell`, and any other built-in by the agent's own name for it —
 * the convention the tool-selection suite records traces in. A traced tool
 * missing from this table makes the capability outcome `invalid`. A web fetch
 * or search reads a source nobody delivered and leaves no harness receipt, so
 * it maps to `read_web`, a capability no case grants and no role grant holds:
 * a trace that reaches the web fails the granted-capabilities grader instead
 * of making the outcome `invalid`.
 *
 * Every built-in Claude Code's capability table (`CLAUDE_CAPABILITY_TOOLS`)
 * can allow is either here or left out of a layer-`G` trace as a tool with no
 * effect of its own (`CLAUDE_HARNESS_INTERNAL_TOOLS` and
 * `CLAUDE_COORDINATION_TOOLS` in `step-one.ts`), so an allowed call never
 * makes the outcome `invalid`. A Codex trace names each item type other than
 * an MCP tool call or a command by its type: a `file_change` writes files and
 * a `web_search` reads the web.
 */
export const TOOL_CAPABILITIES: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Grep: 'read_file',
  Glob: 'read_file',
  LSP: 'read_file',
  Skill: 'read_file',
  Edit: 'write_file',
  Write: 'write_file',
  NotebookEdit: 'write_file',
  file_change: 'write_file',
  shell: 'run_commands',
  KillShell: 'run_commands',
  Monitor: 'run_commands',
  fetch_documentation: 'read_document',
  read_source: 'read_document',
  run_checks: 'run_checks',
  publish_changes: 'publish_change',
  open_pull_request: 'open_change_request',
  update_pull_request_body: 'update_change_request',
  refresh_evidence: 'refresh_evidence',
  read_pull_request: 'read_change_request',
  WebFetch: 'read_web',
  WebSearch: 'read_web',
  web_search: 'read_web'
}

/**
 * How many of each scale's most severe ranks block: a severity blocks when
 * its index in its role's scale is below this, the rank rule the
 * reviewer-quality suites apply to a blocking severity.
 */
const BLOCKING_RANKS = 2

/**
 * The one table from a reviewer severity to `blocking`, read once from each
 * role's own severity scale. A severity missing from its role's row is off
 * the scale, and makes the review outcome `invalid`.
 */
export const SEVERITY_BLOCKING: Readonly<Record<ReviewerRole, Readonly<Record<string, boolean>>>> = Object.fromEntries(
  REVIEWER_ROLES.map((role) => {
    const order = REVIEWER_SEVERITIES[role]
    return [role, Object.fromEntries(order.map((severity, rank) => [severity, rank < BLOCKING_RANKS]))]
  })
) as Record<ReviewerRole, Record<string, boolean>>

/** The agent built-ins a reviewer may hold: reviewers read the change, with its files and with shell commands, and never write it. */
export const REVIEWER_BUILTINS: readonly string[] = ['Read', 'Grep', 'Glob', 'shell']

/** The roles the Vinaya process dispatches for each kind of case, by their name in the role grants. */
export const ROLES_BY_KIND: Readonly<Record<NeutralCaseKind, readonly GrantedRole[]>> = {
  change: ['developer'],
  review: ['code-reviewer', 'security'],
  loop: ['developer', 'code-reviewer', 'security'],
  answer: ['developer']
}

/** Capabilities without which the Vinaya process cannot produce what a kind of case asks for. */
export const REQUIRED_CAPABILITIES: Readonly<Record<NeutralCaseKind, readonly string[]>> = {
  change: ['publish_change', 'open_change_request'],
  review: [],
  loop: ['publish_change', 'open_change_request'],
  answer: []
}

/**
 * Where each neutral case field goes in the Vinaya process input: `rendered`
 * into what the agents receive, `withheld` because only grading reads it, or
 * `inapplicable` because the Vinaya process has nothing it maps to. A case
 * field missing from this table is refused as unexpressible.
 */
export const FIELD_DISPOSITIONS: Readonly<Record<string, FieldDisposition>> = {
  id: 'rendered',
  layer: 'inapplicable',
  kind: 'rendered',
  repository: 'rendered',
  baseRevision: 'rendered',
  taskStatement: 'rendered',
  authorizedScope: 'rendered',
  deliveredDocuments: 'rendered',
  grantedCapabilities: 'rendered',
  hiddenTests: 'withheld',
  referenceSolution: 'withheld',
  plantedDefects: 'withheld',
  changeUnderReview: 'rendered',
  adjudication: 'withheld'
}

/** How a `run_checks` or CI conclusion reads as a neutral check result. */
const CHECK_CONCLUSIONS: Readonly<Record<string, CheckResult['result']>> = {
  success: 'pass',
  failure: 'fail',
  pending: 'pending'
}

// ── Types ───────────────────────────────────────────────────────────────────

export type FieldDisposition = 'rendered' | 'withheld' | 'inapplicable'

/** One document the controller delivers: `required` ones are the brief's `## Documentation` sources. */
export interface RenderedSource {
  sourceId: string
  contentDigest: Digest
  required: boolean
}

/** What the Vinaya process is started with for one neutral case. */
export interface VinayaProcessInput {
  rendererVersion: string
  caseId: string
  caseDigest: Digest
  kind: NeutralCaseKind
  repository: string
  baseRevision: string
  /** The frozen brief, as the Developer and reviewers read it. */
  brief: string
  briefHash: Digest
  /** The case's intent version, which a review bound to this brief is bound to. */
  intentVersion: Digest
  /** The brief's Surface; `null` for an `answer` case, which changes nothing. */
  surface: IssueSurface | null
  objectives: { id: string; text: string }[]
  sources: RenderedSource[]
  /** Each dispatched role's tools, in name order. */
  roleToolGrants: Partial<Record<GrantedRole, string[]>>
  /** The change a review case's reviewers judge; `null` for any other kind. */
  changeUnderReview: ChangeIdentity | null
  dispositions: Record<string, FieldDisposition>
}

export interface RendererRefusal {
  /** `invalid_case` — the case fails its own validation; `unexpressible` — the Vinaya process cannot express it. */
  code: 'invalid_case' | 'unexpressible'
  field: string
  detail: string
}

export type Rendered = { ok: true; input: VinayaProcessInput } | { ok: false; refusal: RendererRefusal }

/**
 * A recorded fact: `undefined` when the harness did not observe it, `null`
 * when it looked and found none, otherwise what it recorded.
 */
export type Observed<T> = T | null | undefined

/** One reviewer run as the controller recorded it: what it dispatched the reviewer with, and its raw structured output. */
export interface RecordedReview {
  reviewId: string
  role: ReviewerRole
  binding: { headSha: string; baseSha: string; briefHash: Digest; diffDigest: Digest }
  output: unknown
}

/** What the harness recorded about one Vinaya trial, together with the input it ran on. */
export interface VinayaTrialRecord {
  rendererVersion: string
  input: VinayaProcessInput
  /** The published pull request: the head and base it names, its diff digest as the forge serves it, and its body. */
  pullRequest: Observed<{ headSha: string; baseSha: string; diffDigest: Digest; body: string }>
  /** What the harness measured from the repository. */
  measuredChange: Observed<{ base: string; head: string; patchDigest: Digest; changedPaths: string[] }>
  /** The hidden tests' results, recorded by the grading sandbox. */
  hiddenTests: Observed<{ revision: string; results: TestResult[] }>
  /** The required-check result on one head, under one evidence id. */
  checks: Observed<{
    evidenceId: string
    headSha: string
    checks: { name: string; required: boolean; conclusion: string }[]
  }>
  reviews: Observed<RecordedReview[]>
  /** The loop's ready-for-merge result: both reviewers approved on the head and every required check green. */
  readyForMerge: Observed<{ id: string; headSha: string; evidenceId: string; reviewIds: string[] }>
  /** The Developer's raw structured output, `{ turnResult }`. */
  developerTurnResult: Observed<unknown>
  receipts: Observed<SourceDeliveryReceipt[]>
  trace: Observed<{ tool: string }[]>
  effects: Observed<{ idempotencyKey: string; kind: string }[]>
}

export type Extracted =
  | { ok: true; rendererVersion: string; outcomes: NeutralOutcomes }
  | { ok: false; refusal: { code: 'stale_renderer' | 'invalid_record'; field: string; detail: string } }

// ── Render ──────────────────────────────────────────────────────────────────

class Unexpressible extends Error {
  constructor(readonly refusal: RendererRefusal) {
    super(refusal.detail)
  }
}

function unexpressible(field: string, detail: string): never {
  throw new Unexpressible({ code: 'unexpressible', field, detail })
}

const sha256 = (text: string): Digest => createHash('sha256').update(text).digest('hex')

/** Whether a catalog tool, which the role grants govern, rather than an agent built-in. */
const isCatalogTool = (tool: string): boolean => AGENT_TOOL_CATALOG.some((entry) => entry.name === tool)

/** A catalog tool as the role grants say; a built-in for the Developer, or a reviewer's built-in for any role. */
const mayHold = (role: GrantedRole, tool: string): boolean =>
  isCatalogTool(tool) ? ROLE_TOOL_GRANTS[role].includes(tool) : role === 'developer' || REVIEWER_BUILTINS.includes(tool)

/**
 * The path a neutral glob covers when Vinaya's `## Surface` can say the same
 * thing. A Surface entry covers a literal path and everything below it, or,
 * as a bare `*`, the repository-root files; so a literal path, optionally
 * followed by `/**`, and a bare `*` are expressible, while any other wildcard
 * cannot be written there without changing what it covers.
 */
function surfaceEntry(glob: string, path: string): string {
  if (glob === '*') return glob
  const entry = glob.replace(/\/\*\*$/, '')
  if (/[*?,`\s]/.test(entry)) {
    unexpressible(path, `${JSON.stringify(glob)} has a wildcard whose coverage a Surface entry cannot state`)
  }
  if (entry.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    unexpressible(path, `${JSON.stringify(glob)} is not a repository-relative path`)
  }
  return entry
}

/** Whether the Surface entry `outer` covers everything `inner` covers: `*` covers each path with no `/`. */
const covers = (outer: string, inner: string) =>
  outer === '*' ? !inner.includes('/') : inner === outer || inner.startsWith(`${outer}/`)

function renderSurface(c: NeutralCase): IssueSurface {
  const scope = c.authorizedScope
  const inEntries = scope.in.map((glob, i) => surfaceEntry(glob, `authorizedScope.in.${i}`))
  for (const [i, glob] of scope.excluded.entries()) surfaceEntry(glob, `authorizedScope.excluded.${i}`)
  const protectedEntries = scope.protected.map((glob, i) => surfaceEntry(glob, `authorizedScope.protected.${i}`))
  // A neutral protected path is allowed where the scope covers it, while a
  // Vinaya `out:` glob wins over `in:`; the two agree only when they never overlap.
  for (const [i, out] of protectedEntries.entries()) {
    const overlapping = inEntries.find((entry) => covers(entry, out) || covers(out, entry))
    if (overlapping !== undefined) {
      unexpressible(
        `authorizedScope.protected.${i}`,
        `protected ${out} overlaps ${overlapping} in the authorized scope, which a Surface's out: glob would override`
      )
    }
  }
  // An excluded path is outside the scope wherever `in` covers it, as a Vinaya
  // `out:` glob is beyond the Surface wherever `in:` covers it.
  return { in: [...scope.in], out: [...scope.excluded, ...scope.protected] }
}

function renderSources(c: NeutralCase): RenderedSource[] {
  return c.deliveredDocuments.map((document, i) => {
    if (/[\s`]/.test(document.id)) {
      unexpressible(
        `deliveredDocuments.${i}.id`,
        `${JSON.stringify(document.id)} cannot be written as one Documentation source`
      )
    }
    // A reviewer's result has no field to report a source use in, so a
    // relevant document could never be shown as used in a review case.
    if (c.kind === 'review' && document.relevant) {
      unexpressible(
        `deliveredDocuments.${i}.relevant`,
        'a reviewer reports no source use, so a review case cannot require one'
      )
    }
    return { sourceId: document.id, contentDigest: document.contentDigest, required: document.relevant }
  })
}

function renderGrants(c: NeutralCase): Partial<Record<GrantedRole, string[]>> {
  const roles = ROLES_BY_KIND[c.kind]
  for (const [i, capability] of c.grantedCapabilities.entries()) {
    const tools = Object.keys(TOOL_CAPABILITIES).filter((tool) => TOOL_CAPABILITIES[tool] === capability)
    if (tools.length === 0) unexpressible(`grantedCapabilities.${i}`, `no Vinaya tool exercises ${capability}`)
    if (!tools.some((tool) => roles.some((role) => mayHold(role, tool)))) {
      unexpressible(`grantedCapabilities.${i}`, `no role a ${c.kind} case dispatches may hold a tool for ${capability}`)
    }
  }
  const missing = REQUIRED_CAPABILITIES[c.kind].filter((needed) => !c.grantedCapabilities.includes(needed))
  if (missing.length > 0) {
    unexpressible(
      'grantedCapabilities',
      `the Vinaya process cannot complete a ${c.kind} case without ${missing.join(', ')}`
    )
  }
  const granted = new Set(c.grantedCapabilities)
  const grants: Partial<Record<GrantedRole, string[]>> = {}
  for (const role of roles) {
    grants[role] = Object.keys(TOOL_CAPABILITIES)
      .filter((tool) => granted.has(TOOL_CAPABILITIES[tool] as string) && mayHold(role, tool))
      .sort()
  }
  return grants
}

function renderBrief(c: NeutralCase, surface: IssueSurface | null, sources: RenderedSource[]): string {
  const required = sources.filter((s) => s.required)
  const surfaceSection =
    surface === null
      ? []
      : [
          '## Surface',
          '',
          `in: ${surface.in.join(', ')}`,
          `out: ${surface.out.length === 0 ? '(none)' : surface.out.join(', ')}`,
          ''
        ]
  return [
    `**Goal:** ${c.taskStatement}`,
    `**Repository:** ${c.repository} at \`${c.baseRevision}\``,
    '',
    '## Objectives',
    '',
    `O1. ${c.taskStatement}`,
    '',
    '## Documentation',
    '',
    ...(required.length === 0 ? ['(none)'] : required.map((s) => `- ${s.sourceId}`)),
    '',
    ...surfaceSection
  ].join('\n')
}

function render(c: NeutralCase): VinayaProcessInput {
  const dispositions: Record<string, FieldDisposition> = {}
  for (const key of Object.keys(c)) {
    const disposition = FIELD_DISPOSITIONS[key]
    if (disposition === undefined) unexpressible(key, `the renderer has no disposition for ${key}`)
    dispositions[key] = disposition
  }
  // The brief is a sequence of single-line sections, so a line break would
  // let the statement start a section of its own.
  if (/[\r\n]/.test(c.taskStatement))
    unexpressible('taskStatement', 'an objective is one line, and the statement has a line break')
  // An answer case changes nothing, so the Developer is dispatched with no Surface.
  const surface = c.kind === 'answer' ? null : renderSurface(c)
  const sources = renderSources(c)
  const roleToolGrants = renderGrants(c)
  const brief = renderBrief(c, surface, sources)
  return {
    rendererVersion: VINAYA_RENDERER_VERSION,
    caseId: c.id,
    caseDigest: neutralCaseDigest(c),
    kind: c.kind,
    repository: c.repository,
    baseRevision: c.baseRevision,
    brief,
    briefHash: sha256(brief),
    intentVersion: intentVersion(c),
    surface,
    objectives: [{ id: 'O1', text: c.taskStatement }],
    sources,
    roleToolGrants,
    changeUnderReview: c.kind === 'review' ? { ...c.changeUnderReview } : null,
    dispositions
  }
}

/** Validates the case, then renders it as Vinaya process input or refuses it naming the field. */
export function renderCase(raw: unknown): Rendered {
  const validated = validateNeutralCase(raw)
  if (!validated.ok) {
    return {
      ok: false,
      refusal: { code: 'invalid_case', field: validated.refusal.path, detail: validated.refusal.detail }
    }
  }
  try {
    return { ok: true, input: render(validated.value) }
  } catch (error) {
    if (error instanceof Unexpressible) return { ok: false, refusal: error.refusal }
    throw error
  }
}

// ── Extract ─────────────────────────────────────────────────────────────────

class Invalid extends Error {}

/** Thrown by a reader that finds the record carries no such fact. */
class Absent extends Error {}

function invalid(detail: string): never {
  throw new Invalid(detail)
}

const COMMIT = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/

function commitOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !COMMIT.test(value)) invalid(`${what} is not a commit id`)
  return value
}

function digestOf(value: unknown, what: string): Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) invalid(`${what} is not a SHA-256 digest`)
  return value
}

function listOf<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) invalid(`${what} is not a list`)
  return value as T[]
}

function stringOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') invalid(`${what} is not a non-empty string`)
  return value
}

/**
 * Reads one outcome: `inapplicable` for a kind that has no such fact,
 * `unavailable` or `absent` for an unobserved or missing record, `invalid`
 * when reading throws, and otherwise the value.
 */
function fact<T>(
  kind: NeutralCaseKind,
  appliesTo: readonly NeutralCaseKind[],
  sources: readonly Observed<unknown>[],
  read: () => T
): Fact<T> {
  if (!appliesTo.includes(kind)) return { status: 'inapplicable' }
  if (sources.some((s) => s === undefined))
    return { status: 'unavailable', reason: 'the trial record does not carry it' }
  if (sources.some((s) => s === null)) return { status: 'absent', reason: 'the trial record records none' }
  try {
    return { status: 'known', value: read() }
  } catch (error) {
    if (error instanceof Invalid) return { status: 'invalid', reason: error.message }
    throw error
  }
}

const PRODUCING: readonly NeutralCaseKind[] = ['change', 'loop']
const ALL: readonly NeutralCaseKind[] = NEUTRAL_CASE_KINDS

function readChange(record: VinayaTrialRecord) {
  const pr = record.pullRequest as NonNullable<VinayaTrialRecord['pullRequest']>
  const measured = record.measuredChange as NonNullable<VinayaTrialRecord['measuredChange']>
  return {
    recorded: {
      base: commitOf(pr.baseSha, 'pullRequest.baseSha'),
      head: commitOf(pr.headSha, 'pullRequest.headSha'),
      patchDigest: digestOf(pr.diffDigest, 'pullRequest.diffDigest')
    },
    measured: {
      base: commitOf(measured.base, 'measuredChange.base'),
      head: commitOf(measured.head, 'measuredChange.head'),
      patchDigest: digestOf(measured.patchDigest, 'measuredChange.patchDigest')
    },
    changedPaths: listOf<unknown>(measured.changedPaths, 'measuredChange.changedPaths').map((p, i) =>
      stringOf(p, `measuredChange.changedPaths.${i}`)
    )
  }
}

function readTests(record: VinayaTrialRecord) {
  const tests = record.hiddenTests as NonNullable<VinayaTrialRecord['hiddenTests']>
  const results = listOf<TestResult>(tests.results, 'hiddenTests.results').map((r, i) => {
    if (!['pass', 'fail', 'skipped', 'not-run'].includes(r?.result))
      invalid(`hiddenTests.results.${i}.result is unknown`)
    return {
      path: stringOf(r.path, `hiddenTests.results.${i}.path`),
      name: stringOf(r.name, `hiddenTests.results.${i}.name`),
      result: r.result
    }
  })
  return { revision: commitOf(tests.revision, 'hiddenTests.revision'), results }
}

function readEvidence(record: VinayaTrialRecord) {
  const evidence = record.checks as NonNullable<VinayaTrialRecord['checks']>
  return {
    id: stringOf(evidence.evidenceId, 'checks.evidenceId'),
    revision: commitOf(evidence.headSha, 'checks.headSha'),
    checks: listOf<{ name: string; required: boolean; conclusion: string }>(evidence.checks, 'checks.checks').map(
      (check, i) => {
        const result = CHECK_CONCLUSIONS[check?.conclusion]
        if (result === undefined)
          invalid(`checks.checks.${i}.conclusion ${JSON.stringify(check?.conclusion)} is unknown`)
        if (typeof check.required !== 'boolean') invalid(`checks.checks.${i}.required is not a boolean`)
        return { name: stringOf(check.name, `checks.checks.${i}.name`), required: check.required, result }
      }
    )
  }
}

/**
 * The beyond-Surface record the review-loop driver writes into the pull
 * request body. A body without the marked block records nothing, which is
 * `absent`, not an empty record.
 */
function readScope(record: VinayaTrialRecord) {
  const body = stringOf(record.pullRequest?.body, 'pullRequest.body')
  if (!/<!--\s*AEG:BEYOND-SURFACE:START\s*-->[\s\S]*<!--\s*AEG:BEYOND-SURFACE:END\s*-->/.test(body)) {
    throw new Absent('the pull request body carries no beyond-Surface record')
  }
  return { recordedOutOfScopePaths: recordedBeyondSurfacePaths(body) }
}

function readCapability(record: VinayaTrialRecord) {
  const used = listOf<{ tool: string }>(record.trace, 'trace').map((call, i) => {
    const capability = TOOL_CAPABILITIES[call?.tool]
    if (capability === undefined) invalid(`trace.${i}: tool ${JSON.stringify(call?.tool)} has no neutral capability`)
    return capability
  })
  return { used: [...new Set(used)] }
}

/**
 * The controller's counted receipts, by content digest, and the sources the
 * Developer's turn result reports using. A reviewer reports no source use,
 * so a review case claims none.
 */
function readSources(record: VinayaTrialRecord) {
  const receipts: SourceReceipt[] = []
  for (const [i, receipt] of listOf<SourceDeliveryReceipt>(record.receipts, 'receipts').entries()) {
    if (receipt?.decision === 'refused') continue
    if (receipt?.decision !== 'counted') invalid(`receipts.${i}.decision is unknown`)
    const delivered = /^sha256:([0-9a-f]{64})$/.exec(String(receipt.deliveredDigest))
    if (delivered === null) invalid(`receipts.${i}.deliveredDigest is not sha256:<hex>`)
    receipts.push({
      documentId: stringOf(receipt.sourceId, `receipts.${i}.sourceId`),
      contentDigest: delivered[1] as Digest
    })
  }
  if (record.input.kind === 'review') return { receipts, claimed: [] }
  const parsed = parseDeveloperTurnResult(record.developerTurnResult, { knownFindingIds: [], requiredSources: [] })
  if (!parsed.ok) invalid(`developerTurnResult: ${parsed.errors.join('; ')}`)
  return { receipts, claimed: [...new Set((parsed.result.sourceUses ?? []).map((use) => use.source))] }
}

/**
 * Each completed review, its findings' severities read through
 * `SEVERITY_BLOCKING`. A blocked review is no review and is left out; a
 * malformed one, one crossed with another role or head, or one with an
 * off-scale severity makes the whole outcome `invalid`.
 */
function readReviews(record: VinayaTrialRecord) {
  const reviews: Review[] = []
  for (const [i, recorded] of listOf<RecordedReview>(record.reviews, 'reviews').entries()) {
    const at = `reviews.${i}`
    const parsed = parseReviewResult(recorded?.output)
    if (!parsed.ok) invalid(`${at}: ${parsed.errors.join('; ')}`)
    const result = parsed.result
    if (result.role !== recorded.role) invalid(`${at}: the result names ${result.role}, dispatched as ${recorded.role}`)
    if (result.headSha !== recorded.binding?.headSha) invalid(`${at}: the result is bound to another head`)
    if (result.status !== 'completed') continue
    const scale = SEVERITY_BLOCKING[recorded.role]
    const findings = result.findings.map((finding, j) => {
      const blocking = scale[finding.severity]
      if (blocking === undefined)
        invalid(`${at}.findings.${j}: ${finding.severity} is not on the ${recorded.role} scale`)
      if (finding.file.trim() === '') invalid(`${at}.findings.${j}: a finding must name a file`)
      return { file: finding.file, blocking }
    })
    const briefHash = digestOf(recorded.binding.briefHash, `${at}.binding.briefHash`)
    reviews.push({
      id: stringOf(recorded.reviewId, `${at}.reviewId`),
      reviewer: recorded.role,
      // A review bound to another brief judged another intent.
      intentVersion: briefHash === record.input.briefHash ? record.input.intentVersion : briefHash,
      change: {
        base: commitOf(recorded.binding.baseSha, `${at}.binding.baseSha`),
        head: commitOf(recorded.binding.headSha, `${at}.binding.headSha`),
        patchDigest: digestOf(recorded.binding.diffDigest, `${at}.binding.diffDigest`)
      },
      findings
    })
  }
  return { reviews }
}

function readDecision(record: VinayaTrialRecord) {
  const ready = record.readyForMerge as NonNullable<VinayaTrialRecord['readyForMerge']>
  return {
    id: stringOf(ready.id, 'readyForMerge.id'),
    outcome: 'ready' as const,
    evidenceId: stringOf(ready.evidenceId, 'readyForMerge.evidenceId'),
    reviewIds: listOf<unknown>(ready.reviewIds, 'readyForMerge.reviewIds').map((id, i) =>
      stringOf(id, `readyForMerge.reviewIds.${i}`)
    )
  }
}

function readEffects(record: VinayaTrialRecord) {
  return {
    effects: listOf<{ idempotencyKey: string; kind: string }>(record.effects, 'effects').map((effect, i) => ({
      idempotencyKey: stringOf(effect?.idempotencyKey, `effects.${i}.idempotencyKey`),
      kind: stringOf(effect?.kind, `effects.${i}.kind`)
    }))
  }
}

/** `fact`, with a reader that may itself find the record carries no such fact. */
function factOrAbsent<T>(
  kind: NeutralCaseKind,
  appliesTo: readonly NeutralCaseKind[],
  sources: readonly Observed<unknown>[],
  read: () => T
): Fact<T> {
  try {
    return fact(kind, appliesTo, sources, read)
  } catch (error) {
    if (error instanceof Absent) return { status: 'absent', reason: error.message }
    throw error
  }
}

function extract(record: VinayaTrialRecord): NeutralOutcomes {
  const kind = record.input.kind
  const sourcesFact: Observed<unknown>[] =
    kind === 'review' ? [record.receipts] : [record.receipts, record.developerTurnResult]
  const decision = fact(kind, ['loop'], [record.readyForMerge], () => readDecision(record))
  return {
    'O-change': fact(kind, PRODUCING, [record.pullRequest, record.measuredChange], () => readChange(record)),
    'O-tests': fact(kind, PRODUCING, [record.hiddenTests], () => readTests(record)),
    'O-evidence': fact(kind, ['loop'], [record.checks], () => readEvidence(record)),
    'O-scope': factOrAbsent(kind, PRODUCING, [record.pullRequest], () => readScope(record)),
    'O-capability': fact(kind, ALL, [record.trace], () => readCapability(record)),
    'O-sources': fact(kind, ALL, sourcesFact, () => readSources(record)),
    'O-review': fact(kind, ['review', 'loop'], [record.reviews], () => readReviews(record)),
    'O-decision':
      decision.status === 'absent' ? { status: 'absent', reason: 'no ready-for-merge result: no Decision' } : decision,
    'O-effects': fact(kind, ALL, [record.effects], () => readEffects(record))
  }
}

/**
 * Extracts the neutral outcomes of one Vinaya trial. A record rendered or
 * recorded under another renderer version is refused: its mapping is not
 * this one.
 */
export function extractOutcomes(record: VinayaTrialRecord): Extracted {
  for (const [field, version] of [
    ['rendererVersion', record?.rendererVersion],
    ['input.rendererVersion', record?.input?.rendererVersion]
  ] as const) {
    if (version !== VINAYA_RENDERER_VERSION) {
      return {
        ok: false,
        refusal: {
          code: 'stale_renderer',
          field,
          detail: `${field} is ${JSON.stringify(version)}, not the current ${VINAYA_RENDERER_VERSION}`
        }
      }
    }
  }
  return { ok: true, rendererVersion: VINAYA_RENDERER_VERSION, outcomes: extract(record) }
}

// ── Version ─────────────────────────────────────────────────────────────────

/** Bumped by hand when the process input or trial record changes shape. */
export const RENDERER_SCHEMA_VERSION = 1

/** The mapping tables the renderer version covers. */
export const MAPPING_TABLES = {
  TOOL_CAPABILITIES,
  REVIEWER_BUILTINS,
  BLOCKING_RANKS,
  CATALOG_TOOL_NAMES: AGENT_TOOL_CATALOG.map((tool) => tool.name),
  SEVERITY_BLOCKING,
  ROLES_BY_KIND,
  REQUIRED_CAPABILITIES,
  FIELD_DISPOSITIONS,
  CHECK_CONCLUSIONS,
  ROLE_TOOL_GRANTS
} as const

/** Every function the render and extract mapping runs; changing any of them changes the version. */
export const MAPPING_LOGIC: readonly ((...args: never[]) => unknown)[] = [
  render,
  renderCase,
  renderSurface,
  surfaceEntry,
  renderSources,
  renderGrants,
  renderBrief,
  mayHold,
  isCatalogTool,
  covers,
  extract,
  extractOutcomes,
  fact,
  factOrAbsent,
  readChange,
  readTests,
  readEvidence,
  readScope,
  readCapability,
  readSources,
  readReviews,
  readDecision,
  readEffects,
  commitOf,
  digestOf,
  listOf,
  stringOf,
  recordedBeyondSurfacePaths
]

/**
 * Every source file the mapping depends on, repository-relative: this module,
 * the neutral case it validates and identifies, the parsers and schemas that
 * decide whether a review or turn result is read as known or invalid, the
 * role grants, and the beyond-Surface reader with the helpers it calls. A
 * function's own text does not show what it calls, so the version digests
 * these files whole; an edit to any of them changes the version, even one
 * that leaves the mapping as it was.
 */
export const MAPPING_SOURCE_PATHS: readonly string[] = [
  'apps/cli/src/lib/dev-review-eval/vinaya-renderer.ts',
  'apps/cli/src/lib/dev-review-eval/neutral-case.ts',
  'apps/cli/src/lib/dev-review-eval/neutral-outcomes.ts',
  'apps/cli/src/lib/dev-review-eval/banned-terms.ts',
  'apps/cli/src/lib/dev-review-eval/contracts.ts',
  'apps/cli/src/lib/review-result.ts',
  'apps/cli/src/lib/developer-turn-result.ts',
  'apps/cli/src/lib/task-tools/role-grants.ts',
  'packages/aeg-core/src/review-policy.ts',
  'packages/aeg-core/src/log/schema.ts',
  'packages/aeg-core/src/issue-validation.ts',
  'packages/aeg-core/src/anchored-region.ts',
  'packages/aeg-forge-state/src/strip-code.ts'
]

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

/** Each mapping source file's content, by its repository-relative path. */
export const MAPPING_SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  MAPPING_SOURCE_PATHS.map((path) => [path, readFileSync(join(REPOSITORY_ROOT, path), 'utf8')])
)

/** The version of a mapping: its schema version and a digest over its tables, its logic and its source files. */
export function rendererVersionOf(
  tables: Readonly<Record<string, unknown>>,
  logic: readonly ((...args: never[]) => unknown)[],
  sources: Readonly<Record<string, string>>
): string {
  const sourceDigests = Object.fromEntries(Object.entries(sources).map(([path, text]) => [path, sha256(text)]))
  const material = `${canonicalJson(tables)}\n${logic.map(String).join('\n')}\n${canonicalJson(sourceDigests)}`
  return `${RENDERER_SCHEMA_VERSION}:${sha256(material)}`
}

export const VINAYA_RENDERER_VERSION = rendererVersionOf(MAPPING_TABLES, MAPPING_LOGIC, MAPPING_SOURCES)
