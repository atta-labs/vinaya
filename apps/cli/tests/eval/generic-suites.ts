/**
 * The layer-`G` suites: developer capability, code reviewer, security
 * reviewer, source citation and the whole loop, each over the neutral cases
 * the re-cut (`recut-generic-cases.ts`) derives from its layer-`P` cases. Each derived
 * file is pinned by the SHA-256 of its bytes; development loading never opens
 * a held-out file, and a held-out file opens only for an approval naming its
 * pinned digest.
 *
 * A case is rendered by the Vinaya renderer and graded by the generic
 * graders alone, on fixture trial records: the reference record is what a
 * Vinaya run of the case's reference solution records, and each known-bad
 * variant plants one defect in it. No model is called and no repository code
 * or hidden test runs.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createSuite, type EvaluationLayer, type Suite } from '../../src/lib/dev-review-eval/contracts'
import { GENERIC_GRADERS, globMatches } from '../../src/lib/dev-review-eval/generic-graders'
import {
  canonicalJson,
  type NeutralCase,
  neutralCaseDigest,
  validateNeutralCase
} from '../../src/lib/dev-review-eval/neutral-case'
import { extractOutcomes, renderCase, type VinayaTrialRecord } from '../../src/lib/dev-review-eval/vinaya-renderer'
import { REVIEWER_SEVERITIES, type ReviewerRole } from '../../src/lib/review-result'
import {
  type DeveloperCapabilityCase,
  loadCaseFile as loadDeveloperCaseFile,
  loadHeldOutCases as loadDeveloperHeldOut
} from './developer-capability-suite'
import { DERIVED_FILES, GENERIC_SUITE_IDS } from './recut-generic-cases'
import { type FixtureEntry, KNOWN_BAD_VARIANTS, referenceRecord } from './vinaya-trial-records'

export type GenericSuiteKey = keyof typeof GENERIC_SUITE_IDS

/** Process layer `G`: every grader of these suites reads only a neutral case and its neutral outcomes. */
export const GENERIC_SUITES_PROCESS_LAYER = 'G' as const

/** The SHA-256 of each derived file's bytes, as the re-cut wrote it. */
export const DERIVED_FILE_DIGESTS = {
  developer: {
    development: '760c299643289c12066573eca3b6e946c68ece42855f0e8966fffbf36efed104',
    heldOut: '63c4609c88a113606cba68c3866431d40c2094274c7f11280a3114896c252214'
  },
  reviewer: {
    development: 'a2161462e9012c5c77eee21c6d2ece09c3d34d89464b763ec3f58fd334a1e355',
    heldOut: '9f7c980ade34b6ccf4d6541b47c3805f8cd327608d41b0f070dab26158331cf7'
  },
  sourceCitation: {
    development: 'd913e995ba891830f744cea1c1beca799bff0b46bee4fc00a1850e6e1b324f0f',
    heldOut: '63259630cdfcd7594110c8f61241587eaa6b5a8cab12c9fbf31bdc73510e409c'
  },
  wholeLoop: {
    development: '9adf5dd377eaf0f2b7c49afa6ea54d5805963c4141d7750822a293657c2a32a9',
    heldOut: '8b6a42b7669d1a10f03e7f4a9a060dbf54d006e84162249279789075473d171b'
  }
} as const

/** Each suite's held-out case ids, the public index of its held-out file. */
export const HELD_OUT_IDS: Readonly<Record<GenericSuiteKey, readonly string[]>> = {
  developer: [
    'pr-980',
    'pr-988',
    'pr-1000',
    'pr-1001',
    'pr-1004',
    'pr-1006',
    'pr-1007',
    'pr-1008',
    'pr-1027',
    'pr-1075',
    'pr-1076',
    'pr-1085',
    'pr-1097',
    'pr-1103',
    'pr-1105',
    'pr-1107',
    'pr-1124',
    'pr-1135',
    'pr-1156',
    'pr-1210',
    'pr-1211',
    'pr-1243',
    'pr-1257',
    'pr-1262',
    'pr-1272',
    'pr-1275',
    'pr-1283',
    'pr-1284',
    'pr-1304',
    'pr-1305',
    'pr-1306',
    'pr-1310'
  ],
  codeReviewer: ['code-held-clean'],
  securityReviewer: ['security-held-clean'],
  sourceCitation: [
    'ho-correct-citation',
    'ho-missing-citation',
    'ho-undelivered-source',
    'ho-irrelevant-source',
    'ho-source-mutation',
    'ho-receipt-fabrication',
    'ho-no-source-balance'
  ],
  wholeLoop: [
    'pr-980',
    'pr-988',
    'pr-1000',
    'pr-1001',
    'pr-1004',
    'pr-1006',
    'pr-1007',
    'pr-1008',
    'pr-1027',
    'pr-1075',
    'pr-1076',
    'pr-1085',
    'pr-1097',
    'pr-1103',
    'pr-1105',
    'pr-1107',
    'pr-1124',
    'pr-1135',
    'pr-1156',
    'pr-1210',
    'pr-1211',
    'pr-1243',
    'pr-1257',
    'pr-1262',
    'pr-1272',
    'pr-1275',
    'pr-1283',
    'pr-1284',
    'pr-1304',
    'pr-1305',
    'pr-1306',
    'pr-1310'
  ]
}

/** The derived file each suite's cases live in. */
const FAMILY: Readonly<Record<GenericSuiteKey, keyof typeof DERIVED_FILE_DIGESTS>> = {
  developer: 'developer',
  codeReviewer: 'reviewer',
  securityReviewer: 'reviewer',
  sourceCitation: 'sourceCitation',
  wholeLoop: 'wholeLoop'
}

/**
 * Each suite's pinned held-out digest, by its name without the `@` version:
 * every suite whose derived file has a held-out split. The freeze record's
 * standalone held-out baseline is checked against it.
 */
export function heldOutDigestsBySuite(): Record<string, string> {
  const digests: Record<string, string> = {}
  for (const key of Object.keys(GENERIC_SUITE_IDS) as GenericSuiteKey[]) {
    const pinned: { heldOut?: string } = DERIVED_FILE_DIGESTS[FAMILY[key]]
    if (pinned.heldOut === undefined) continue
    digests[GENERIC_SUITE_IDS[key].split('@')[0] as string] = pinned.heldOut
  }
  return digests
}

/** Each suite's cost layer: the whole loop runs every role against a real forge, the rest one role each. */
const LAYER: Readonly<Record<GenericSuiteKey, EvaluationLayer>> = {
  developer: 'L5',
  codeReviewer: 'L5',
  securityReviewer: 'L5',
  sourceCitation: 'L5',
  wholeLoop: 'L6'
}

/** The suites whose cases are cut from a layer-`P` developer case, whose reference trials need that case. */
export const DEVELOPER_DERIVED: readonly GenericSuiteKey[] = ['developer', 'wholeLoop']

/** The reviewer whose findings a review suite's reference records. */
const REVIEWER_OF: Partial<Record<GenericSuiteKey, ReviewerRole>> = {
  codeReviewer: 'code-reviewer',
  securityReviewer: 'security-reviewer'
}

export type ReadBytes = (path: string) => Buffer
const defaultRead: ReadBytes = (path) => readFileSync(path)
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export class DerivedFileRefused extends Error {}

interface DerivedFileShape {
  schemaVersion: 1
  split: 'development' | 'held-out'
  suites: { suite: string; cases: unknown[]; layerPOnly: string[]; variants?: Record<string, string[]> }[]
}

function load(path: string, pinned: string, split: DerivedFileShape['split'], read: ReadBytes): DerivedFileShape {
  const bytes = read(path)
  if (sha256(bytes) !== pinned) throw new DerivedFileRefused(`${path} differs from its pinned digest`)
  const file = JSON.parse(bytes.toString('utf8')) as DerivedFileShape
  if (file.schemaVersion !== 1 || file.split !== split) throw new DerivedFileRefused(`${path} header is invalid`)
  return file
}

function entryOf(file: DerivedFileShape, key: GenericSuiteKey): DerivedFileShape['suites'][number] {
  const entry = file.suites.find((s) => s.suite === GENERIC_SUITE_IDS[key])
  if (entry === undefined) throw new DerivedFileRefused(`no ${GENERIC_SUITE_IDS[key]} cases`)
  return entry
}

function casesOf(file: DerivedFileShape, key: GenericSuiteKey): NeutralCase[] {
  return entryOf(file, key).cases.map((raw, i) => {
    const validated = validateNeutralCase(raw)
    // A refusal names the case by its position and digest only.
    if (!validated.ok)
      throw new DerivedFileRefused(`${key} case ${i} (sha256:${sha256(canonicalJson(raw))}) is invalid`)
    return validated.value
  })
}

function developmentFile(key: GenericSuiteKey, read: ReadBytes): DerivedFileShape {
  const family = FAMILY[key]
  return load(DERIVED_FILES[family].development, DERIVED_FILE_DIGESTS[family].development, 'development', read)
}

/** The sole held-out read path: it opens a held-out file only for an approval naming its pinned digest. */
function heldOutFile(key: GenericSuiteKey, approval: string, read: ReadBytes): DerivedFileShape {
  const family = FAMILY[key]
  const pinned = DERIVED_FILE_DIGESTS[family].heldOut
  if (approval !== pinned) throw new DerivedFileRefused(`the held-out split opens only with approval ${pinned}`)
  const file = load(DERIVED_FILES[family].heldOut, pinned, 'held-out', read)
  if (
    canonicalJson(entryOf(file, key).cases.map((c) => (c as { id: unknown }).id)) !== canonicalJson(HELD_OUT_IDS[key])
  ) {
    throw new DerivedFileRefused(`${key} held-out cases differ from the pinned index`)
  }
  return file
}

/** A suite's development cases. The development path: it never opens a held-out file. */
export function developmentCases(key: GenericSuiteKey, read: ReadBytes = defaultRead): NeutralCase[] {
  return casesOf(developmentFile(key, read), key)
}

/** A suite's held-out cases, read only through the held-out path. */
export function heldOutCases(key: GenericSuiteKey, approval: string, read: ReadBytes = defaultRead): NeutralCase[] {
  return casesOf(heldOutFile(key, approval, read), key)
}

/**
 * The live variants a suite's development cases carry, each mapped to the
 * ids of the cases it applies to; a suite that marks none has none.
 */
export function developmentVariants(key: GenericSuiteKey, read: ReadBytes = defaultRead): Record<string, string[]> {
  return entryOf(developmentFile(key, read), key).variants ?? {}
}

/** The live variants a suite's held-out cases carry, read only through the held-out path. */
export function heldOutVariants(
  key: GenericSuiteKey,
  approval: string,
  read: ReadBytes = defaultRead
): Record<string, string[]> {
  return entryOf(heldOutFile(key, approval, read), key).variants ?? {}
}

/** The harness suite: its name, version and layer from the registry, its splits fixed at creation. */
export function genericSuite(key: GenericSuiteKey, read: ReadBytes = defaultRead): Readonly<Suite> {
  const [name, version] = GENERIC_SUITE_IDS[key].split('@') as [string, string]
  const created = createSuite({
    name,
    version: Number(version),
    layer: LAYER[key],
    kind: 'capability',
    splits: { development: developmentCases(key, read).map((c) => c.id), heldOut: [...HELD_OUT_IDS[key]] }
  })
  if (!created.ok) throw new Error(`suite refused: ${JSON.stringify(created.refusal)}`)
  return created.value
}

// ── Reference trials ────────────────────────────────────────────────────────

/** Every path the merged change touched: its hidden test files and its reference solution. */
function referencePaths(p: DeveloperCapabilityCase): string[] {
  return [
    ...new Set([
      ...p.hiddenTests.files.map((f) => f.path),
      ...p.hiddenTests.deleted,
      ...p.referenceSolution.files.map((f) => f.path),
      ...p.referenceSolution.deleted
    ])
  ]
}

/**
 * What a Vinaya run of the case's reference solution records: a developer
 * case the merged change, a loop case the merged change approved by both
 * reviewers on its head, a review case a blocking finding from the suite's
 * reviewer at each unjustified planted defect, an answer case a reply citing
 * its relevant documents.
 */
export function referenceEntry(
  key: GenericSuiteKey,
  c: NeutralCase,
  developerCase?: DeveloperCapabilityCase
): FixtureEntry {
  const findings: FixtureEntry['reference']['findings'] = { 'code-reviewer': [], 'security-reviewer': [] }
  const reads = c.grantedCapabilities.includes('read_document') ? ['fetch_documentation'] : []
  if (c.kind === 'change' || c.kind === 'loop') {
    if (developerCase === undefined || developerCase.id !== c.id) throw new Error(`${c.id} needs its layer-P case`)
    const trace = [
      'Read',
      'Edit',
      'shell',
      ...(c.deliveredDocuments.length > 0 ? reads : []),
      'publish_changes',
      'open_pull_request'
    ]
    return {
      case: c,
      reference: { head: developerCase.referenceCommit, changedPaths: referencePaths(developerCase), trace, findings }
    }
  }
  if (c.kind === 'review') {
    const role = REVIEWER_OF[key] as ReviewerRole
    // The second rank of the role's scale: blocking, and not its most severe.
    const severity = REVIEWER_SEVERITIES[role][1] as string
    findings[role] = c.plantedDefects.filter((d) => !d.justified).map((d) => ({ file: d.file, severity }))
    return { case: c, reference: { changedPaths: [], trace: ['Read'], findings } }
  }
  return { case: c, reference: { changedPaths: [], trace: reads, findings } }
}

type KnownBadVariant = (typeof KNOWN_BAD_VARIANTS)[number]

/** A known-bad variant that applies to `loop` cases only, planted in a copy of the reference record. */
function loopVariant(
  name: string,
  graderId: string,
  plant: (bad: VinayaTrialRecord) => void,
  applies: (c: NeutralCase) => boolean = () => true
): KnownBadVariant {
  return {
    name,
    graderId,
    plant(record, { case: c }) {
      if (c.kind !== 'loop' || !applies(c)) return null
      const bad = structuredClone(record)
      plant(bad)
      return bad
    }
  }
}

/** A path no committed case's authorized scope covers. */
const UNRECORDED_PATH = 'planted-outside-scope/planted.txt'

/**
 * The known-bad variants of the loop graders the shared variants leave
 * untargeted, each planting one defect in a loop's reference record.
 */
export const LOOP_KNOWN_BAD_VARIANTS: readonly KnownBadVariant[] = [
  // A path changed outside the authorized scope that the pull request does not record.
  loopVariant(
    'unrecorded out-of-scope change',
    'generic-scope-kept',
    (bad) => {
      if (bad.measuredChange) bad.measuredChange.changedPaths = [...bad.measuredChange.changedPaths, UNRECORDED_PATH]
    },
    (c) => !c.authorizedScope.in.some((glob) => globMatches(glob, UNRECORDED_PATH))
  ),
  // A review bound to another brief judged another intent.
  loopVariant('review bound to another brief', 'generic-review-bound', (bad) => {
    for (const review of bad.reviews ?? []) review.binding.briefHash = 'e'.repeat(64)
  }),
  // The decision rests on evidence that is no longer the current evidence.
  loopVariant('decision on stale evidence', 'generic-decision-bound', (bad) => {
    if (bad.readyForMerge) bad.readyForMerge.evidenceId = 'stale-evidence'
  }),
  // The pull request records a patch other than the one measured.
  loopVariant('recorded change differs from the measured one', 'generic-change-bound', (bad) => {
    if (bad.pullRequest) bad.pullRequest.diffDigest = 'd'.repeat(64)
  }),
  // The publication performed twice under one idempotency key.
  loopVariant('effect performed twice', 'generic-effects-once', (bad) => {
    bad.effects = [...(bad.effects ?? []), ...(bad.effects ?? []).slice(0, 1)]
  })
]

/** Every generic grader's verdict on one trial record of the case, by grader id. */
export async function gradeRecord(c: NeutralCase, record: VinayaTrialRecord): Promise<Record<string, string>> {
  const extracted = extractOutcomes(record)
  if (!extracted.ok) throw new Error(`${c.id}: extraction refused (${extracted.refusal.code})`)
  const verdicts: Record<string, string> = {}
  for (const grader of GENERIC_GRADERS) {
    verdicts[grader.identity.id] = (await grader.grade({ case: c, outcomes: extracted.outcomes })).verdict
  }
  return verdicts
}

/** One way a case's round trip went wrong, named by case id, digest and the check only. */
export interface RoundTripFailure {
  id: string
  digest: string
  check: string
}

/**
 * Renders each case, grades its reference record with the generic graders,
 * and grades each known-bad variant that applies: the reference must pass
 * every grader, and each variant must fail the grader it targets and no other.
 */
export async function roundTrip(
  key: GenericSuiteKey,
  cases: readonly NeutralCase[],
  developerCases: readonly DeveloperCapabilityCase[] = []
): Promise<{ cases: number; variants: number; failures: RoundTripFailure[]; targeted: Record<string, string[]> }> {
  const failures: RoundTripFailure[] = []
  const targeted: Record<string, string[]> = {}
  let variants = 0
  for (const c of cases) {
    targeted[c.id] = []
    const fail = (check: string) => failures.push({ id: c.id, digest: neutralCaseDigest(c), check })
    const rendered = renderCase(c)
    if (!rendered.ok) {
      fail(`render refused at ${rendered.refusal.field}`)
      continue
    }
    const entry = referenceEntry(
      key,
      c,
      developerCases.find((p) => p.id === c.id)
    )
    const reference = referenceRecord(entry, rendered.input)
    for (const [grader, verdict] of Object.entries(await gradeRecord(c, reference))) {
      if (verdict !== 'pass') fail(`reference fails ${grader}`)
    }
    for (const variant of [...KNOWN_BAD_VARIANTS, ...LOOP_KNOWN_BAD_VARIANTS]) {
      const bad = variant.plant(reference, entry)
      if (bad === null) continue
      variants++
      targeted[c.id]?.push(variant.graderId)
      for (const [grader, verdict] of Object.entries(await gradeRecord(c, bad))) {
        const expected = grader === variant.graderId ? 'fail' : 'pass'
        if (verdict !== expected) fail(`${variant.name} gives ${grader} ${verdict}`)
      }
    }
  }
  return { cases: cases.length, variants, failures, targeted }
}

/** The layer-`P` developer cases the reference trials of a split are cut from. */
export function developerReferenceCases(split: 'development' | 'held-out'): DeveloperCapabilityCase[] {
  const file = loadDeveloperCaseFile()
  return split === 'development' ? file.cases : loadDeveloperHeldOut(file, file.splits.heldOut.digest)
}
