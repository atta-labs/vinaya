/**
 * The neutral case: one layer-`G` test case stated in the Development Process
 * vocabulary (Intent, Execution, Change, Evidence, Review, Decision) and in
 * nothing one process owns. A case names the repository and base revision it
 * starts from, the task as a plain statement, the authorized scope, the
 * documents delivered to the agent and the capabilities granted to it, and,
 * by kind:
 *
 *  - `change` — produce a change: the hidden tests that judge it and the
 *    reference solution proving it solvable;
 *  - `review` — judge a given change: the defects planted in it, the change
 *    under review and how the change was adjudicated;
 *  - `loop` — take a task through change, evidence and review to a decision:
 *    the hidden tests and the reference solution.
 *
 * `validateNeutralCase` returns the case or refuses it naming the field, with
 * the harness's refusal codes. `neutralCaseDigest` identifies a validated case
 * independently of key order.
 */

import { createHash } from 'node:crypto'
import { checkTaskStatement } from './banned-terms'
import {
  commit,
  type Digest,
  digest,
  distinct,
  field,
  join,
  list,
  name,
  oneOf,
  record,
  refuse,
  run,
  text,
  type Validated
} from './contracts'

export const NEUTRAL_CASE_KINDS = ['change', 'review', 'loop'] as const
export type NeutralCaseKind = (typeof NEUTRAL_CASE_KINDS)[number]

/** Path globs: `in` is what the task may change; `protected` is what it may not, unless `in` covers it. */
export interface AuthorizedScope {
  in: string[]
  protected: string[]
}

/** A document delivered to the agent, pinned by its content digest; `relevant` documents must be used. */
export interface DeliveredDocument {
  id: string
  contentDigest: Digest
  relevant: boolean
}

/** A test withheld from the agent and applied only when grading. */
export interface HiddenTest {
  path: string
  name: string
  expectation: 'fail-to-pass' | 'pass-to-pass'
}

/** A change pinned by its base, its head and the digest of its patch. */
export interface ChangeIdentity {
  base: string
  head: string
  patchDigest: Digest
}

/**
 * A defect planted at a known file. `blocking` and `critical` say how serious
 * it is; a `justified` one is a deliberate change the review should accept.
 */
export interface PlantedDefect {
  file: string
  kind: string
  blocking: boolean
  critical: boolean
  justified: boolean
}

/** How independent adjudicators judged the change under review. */
export interface Adjudication {
  clean: boolean
  adjudicators: string[]
}

interface NeutralCaseCommon {
  id: string
  layer: 'G'
  repository: string
  baseRevision: string
  taskStatement: string
  authorizedScope: AuthorizedScope
  deliveredDocuments: DeliveredDocument[]
  grantedCapabilities: string[]
}

export interface ChangeCase extends NeutralCaseCommon {
  kind: 'change'
  hiddenTests: HiddenTest[]
  referenceSolution: { patchDigest: Digest }
}

export interface ReviewCase extends NeutralCaseCommon {
  kind: 'review'
  plantedDefects: PlantedDefect[]
  changeUnderReview: ChangeIdentity
  adjudication: Adjudication
}

export interface LoopCase extends NeutralCaseCommon {
  kind: 'loop'
  hiddenTests: HiddenTest[]
  referenceSolution: { patchDigest: Digest }
}

export type NeutralCase = ChangeCase | ReviewCase | LoopCase

/** The fields each kind requires beyond the common ones; a field of another kind is refused. */
export const KIND_FIELDS: Readonly<Record<NeutralCaseKind, readonly string[]>> = {
  change: ['hiddenTests', 'referenceSolution'],
  review: ['plantedDefects', 'changeUnderReview', 'adjudication'],
  loop: ['hiddenTests', 'referenceSolution']
}

// ── Validation ──────────────────────────────────────────────────────────────

function flag(input: unknown, path: string): boolean {
  if (typeof input !== 'boolean') refuse('wrong_type', path, `${path} must be a boolean`)
  return input
}

function texts(input: unknown, path: string): string[] {
  const values = list(input, path, text)
  distinct(values, path)
  return values
}

function scope(input: unknown, path: string): AuthorizedScope {
  const obj = record(input, path)
  const inGlobs = texts(field(obj, 'in', path), join(path, 'in'))
  if (inGlobs.length === 0) refuse('empty', join(path, 'in'), `${join(path, 'in')} must name at least one glob`)
  return { in: inGlobs, protected: texts(field(obj, 'protected', path), join(path, 'protected')) }
}

function deliveredDocument(input: unknown, path: string): DeliveredDocument {
  const obj = record(input, path)
  return {
    id: text(field(obj, 'id', path), join(path, 'id')),
    contentDigest: digest(field(obj, 'contentDigest', path), join(path, 'contentDigest')),
    relevant: flag(field(obj, 'relevant', path), join(path, 'relevant'))
  }
}

function hiddenTest(input: unknown, path: string): HiddenTest {
  const obj = record(input, path)
  return {
    path: text(field(obj, 'path', path), join(path, 'path')),
    name: text(field(obj, 'name', path), join(path, 'name')),
    expectation: oneOf(field(obj, 'expectation', path), join(path, 'expectation'), [
      'fail-to-pass',
      'pass-to-pass'
    ] as const)
  }
}

function hiddenTests(input: unknown, path: string): HiddenTest[] {
  const tests = list(input, path, hiddenTest)
  if (tests.length === 0) refuse('empty', path, `${path} must name at least one hidden test`)
  distinct(
    tests.map((t) => `${t.path} ${t.name}`),
    path
  )
  return tests
}

export function changeIdentity(input: unknown, path: string): ChangeIdentity {
  const obj = record(input, path)
  return {
    base: commit(field(obj, 'base', path), join(path, 'base')),
    head: commit(field(obj, 'head', path), join(path, 'head')),
    patchDigest: digest(field(obj, 'patchDigest', path), join(path, 'patchDigest'))
  }
}

function plantedDefect(input: unknown, path: string): PlantedDefect {
  const obj = record(input, path)
  return {
    file: text(field(obj, 'file', path), join(path, 'file')),
    kind: text(field(obj, 'kind', path), join(path, 'kind')),
    blocking: flag(field(obj, 'blocking', path), join(path, 'blocking')),
    critical: flag(field(obj, 'critical', path), join(path, 'critical')),
    justified: flag(field(obj, 'justified', path), join(path, 'justified'))
  }
}

function adjudication(input: unknown, path: string): Adjudication {
  const obj = record(input, path)
  const adjudicators = texts(field(obj, 'adjudicators', path), join(path, 'adjudicators'))
  // A clean set is two adjudicators agreeing independently, so one is never enough.
  if (adjudicators.length < 2) {
    refuse('out_of_range', join(path, 'adjudicators'), `${join(path, 'adjudicators')} must name at least two`)
  }
  return { clean: flag(field(obj, 'clean', path), join(path, 'clean')), adjudicators }
}

function neutralCase(input: unknown): NeutralCase {
  const obj = record(input, '')
  const id = name(field(obj, 'id', ''), 'id')
  oneOf(field(obj, 'layer', ''), 'layer', ['G'] as const)
  const kind = oneOf(field(obj, 'kind', ''), 'kind', NEUTRAL_CASE_KINDS)
  const statement = checkTaskStatement(text(field(obj, 'taskStatement', ''), 'taskStatement'))
  if (!statement.ok) refuse(statement.refusal.code, statement.refusal.path, statement.refusal.detail)
  const deliveredDocuments = list(field(obj, 'deliveredDocuments', ''), 'deliveredDocuments', deliveredDocument)
  distinct(
    deliveredDocuments.map((d) => d.id),
    'deliveredDocuments.id'
  )
  const common: NeutralCaseCommon = {
    id,
    layer: 'G',
    repository: text(field(obj, 'repository', ''), 'repository'),
    baseRevision: commit(field(obj, 'baseRevision', ''), 'baseRevision'),
    taskStatement: statement.value,
    authorizedScope: scope(field(obj, 'authorizedScope', ''), 'authorizedScope'),
    deliveredDocuments,
    grantedCapabilities: texts(field(obj, 'grantedCapabilities', ''), 'grantedCapabilities')
  }

  for (const other of NEUTRAL_CASE_KINDS) {
    for (const key of KIND_FIELDS[other]) {
      if (!KIND_FIELDS[kind].includes(key) && key in obj) {
        refuse('inconsistent', key, `a ${kind} case carries no ${key}`)
      }
    }
  }

  if (kind === 'review') {
    const plantedDefects = list(field(obj, 'plantedDefects', ''), 'plantedDefects', plantedDefect)
    const changeUnderReview = changeIdentity(field(obj, 'changeUnderReview', ''), 'changeUnderReview')
    const judged = adjudication(field(obj, 'adjudication', ''), 'adjudication')
    if (changeUnderReview.base !== common.baseRevision) {
      refuse('inconsistent', 'changeUnderReview.base', 'changeUnderReview.base differs from baseRevision')
    }
    if (judged.clean && plantedDefects.length > 0) {
      refuse('inconsistent', 'plantedDefects', 'a change adjudicated clean carries no planted defect')
    }
    if (!judged.clean && plantedDefects.length === 0) {
      refuse('empty', 'plantedDefects', 'a change not adjudicated clean must carry at least one planted defect')
    }
    return { ...common, kind, plantedDefects, changeUnderReview, adjudication: judged }
  }

  const referencePath = 'referenceSolution'
  const rawReference = record(field(obj, referencePath, ''), referencePath)
  return {
    ...common,
    kind,
    hiddenTests: hiddenTests(field(obj, 'hiddenTests', ''), 'hiddenTests'),
    referenceSolution: {
      patchDigest: digest(field(rawReference, 'patchDigest', referencePath), join(referencePath, 'patchDigest'))
    }
  }
}

export function validateNeutralCase(input: unknown): Validated<NeutralCase> {
  return run(input, neutralCase)
}

// ── Identity ────────────────────────────────────────────────────────────────

/** JSON with every object's keys sorted, so equal values serialize equally whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sha256 = (text: string): Digest => createHash('sha256').update(text).digest('hex')

/** The SHA-256 of the case's canonical JSON: stable under key order, changed by any field. */
export function neutralCaseDigest(c: NeutralCase): Digest {
  return sha256(canonicalJson(c))
}

/**
 * The version of the case's intent — what is asked and where it may change —
 * which a review must be bound to.
 */
export function intentVersion(c: NeutralCase): Digest {
  return sha256(canonicalJson({ taskStatement: c.taskStatement, authorizedScope: c.authorizedScope }))
}
