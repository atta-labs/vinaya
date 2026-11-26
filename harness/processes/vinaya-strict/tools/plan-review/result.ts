/**
 * The Plan reviewer's answer — the one structured value the seat's session ends
 * with, delivered as each CLI's native structured final output (Claude Code
 * `--json-schema`, Codex `--output-schema`).
 *
 * The seat answers six fixed questions (version `PLAN_REVIEW_QUESTION_VERSION`):
 * five asked of every task, one asked of the whole plan. The answer holds one
 * answer per task for each of questions 1 to 5, one answer for question 6, each
 * with evidence, and the findings. It carries no verdict: `derivePlanVerdict`
 * reads one off a valid answer, so the reviewer never decides it.
 *
 * Nothing the seat writes decides what it judged. The draft's fingerprint, the
 * question version and the captured revision it names are claims, checked against
 * the draft the controller held (`PlanReviewBinding`). Every piece of evidence is
 * checked too: a location must exist at the captured revision, a command must begin
 * with an allowed read-only prefix (it is never run: its output is what the seat
 * saw), a scope passage must be a passage of the draft's agreed scope. An answer
 * that fails any check is not a review.
 *
 * One schema serves both vendors, so it is written to the strictest common shape:
 * one root key, every optional field a required, nullable one. The same zod value
 * generates the JSON Schema the CLIs receive and validates what comes back.
 */

import { z } from 'zod/v4'
import { type PlanDraft, draftFingerprint } from '../plan-draft/draft'

/** The one schema version this module produces and accepts. */
export const PLAN_REVIEW_SCHEMA_VERSION = 1

/** The version of the fixed questions the seat's doctrine states. */
export const PLAN_REVIEW_QUESTION_VERSION = '1'

/** Questions 1 to 5 are asked of each task; question 6 of the whole plan. */
export const TASK_QUESTIONS = [1, 2, 3, 4, 5] as const
export const PLAN_QUESTION = 6
export const PLAN_REVIEW_QUESTIONS = [1, 2, 3, 4, 5, 6] as const

export const PLAN_REVIEW_QUESTION_NAMES = {
  1: 'Inputs',
  2: 'Proof',
  3: 'Facts',
  4: 'Relations',
  5: 'Intent',
  6: 'Coverage'
} as const

/**
 * The read-only command prefixes the seat may cite as evidence, and the list its grants allow:
 * reading a file at a revision, searching, listing and reading history. A test binds this list
 * to `thinking/plan-reviewer/grants.yaml`.
 */
export const PLAN_REVIEW_EVIDENCE_COMMANDS: readonly string[] = [
  'git show',
  'git cat-file',
  'git ls-tree',
  'git ls-files',
  'git grep',
  'git log',
  'git diff',
  'rg',
  'grep',
  'ls'
]

export const EVIDENCE_KINDS = ['code', 'command', 'scope'] as const
export const FINDING_KINDS = ['blocking', 'note'] as const

const schemaVersion = z.literal(PLAN_REVIEW_SCHEMA_VERSION)
const question = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])

/**
 * One piece of evidence. A strict structured output has no optional field, so the three kinds share one
 * shape: the fields a kind does not use are `null`, and the semantic check refuses a kind missing its own.
 */
const EvidenceSchema = z
  .object({
    kind: z.enum(EVIDENCE_KINDS),
    /** `code`: the file at the captured revision. */
    path: z.string().min(1).nullable(),
    /** `code`: a line inside that file. */
    line: z.number().int().min(1).nullable(),
    /** `command`: the read-only command the seat ran. */
    command: z.string().min(1).nullable(),
    /** `command`: what it printed. */
    output: z.string().nullable(),
    /** `scope`: a passage of the draft's agreed scope. */
    passage: z.string().min(1).nullable()
  })
  .strict()

const AnswerSchema = z
  .object({
    question,
    /** The tranche task number the answer is for; `null` for question 6, which is asked of the whole plan. */
    task: z.number().int().min(1).nullable(),
    answer: z.string().min(1),
    evidence: z.array(EvidenceSchema)
  })
  .strict()

const FindingSchema = z
  .object({
    question,
    task: z.number().int().min(1).nullable(),
    kind: z.enum(FINDING_KINDS),
    evidence: z.array(EvidenceSchema),
    /** What would resolve it. */
    resolution: z.string().min(1)
  })
  .strict()

export const PlanReviewSchema = z
  .object({
    schemaVersion,
    draftFingerprint: z.string().min(1),
    questionVersion: z.string().min(1),
    revision: z.string().min(1),
    summary: z.string().min(1),
    answers: z.array(AnswerSchema),
    findings: z.array(FindingSchema)
  })
  .strict()

/** The structured output the provider is asked for: the answer under one root key. */
export const PlanReviewOutputSchema = z.object({ planReview: PlanReviewSchema }).strict()

export type PlanReviewEvidence = z.infer<typeof EvidenceSchema>
export type PlanReviewAnswer = z.infer<typeof AnswerSchema>
export type PlanReviewFinding = z.infer<typeof FindingSchema>
export type PlanReview = z.infer<typeof PlanReviewSchema>

/** The JSON Schema handed to the vendor CLI. `$schema` is dropped: neither CLI needs it. */
export function planReviewJsonSchema(): Record<string, unknown> {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(PlanReviewOutputSchema, { target: 'draft-7' }) as Record<
    string,
    unknown
  >
  return rest
}

/** What the controller knows about the review it dispatched — never read from the seat. */
export type PlanReviewBinding = {
  /** The exact draft the seat judged; its fingerprint, question version and revision are the answer's binding. */
  readonly draft: PlanDraft
  /** The number of lines of a file at the draft's captured revision, or `null` when the file is not there. */
  readonly lineCount: (path: string) => number | null
}

/** Why an answer is not a review. */
export type PlanReviewRefusal = 'malformed' | 'stale' | 'incomplete' | 'unverified' | 'rejected'

export type PlanReviewValidation =
  | { ok: true; review: PlanReview }
  | { ok: false; reason: PlanReviewRefusal; errors: string[] }

/** The shape check alone: does `value` match the schema the provider was given? Returns the unwrapped answer. */
export function parsePlanReview(value: unknown): PlanReviewValidation {
  const parsed = PlanReviewOutputSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'malformed',
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    }
  }
  return { ok: true, review: parsed.data.planReview }
}

/** Errors that make an answer belong to another review than this one — a stale or crossed answer. */
export function bindingErrors(review: PlanReview, binding: PlanReviewBinding): string[] {
  const errors: string[] = []
  const fingerprint = draftFingerprint(binding.draft)
  if (review.draftFingerprint !== fingerprint) {
    errors.push(
      `draftFingerprint: the answer is bound to ${review.draftFingerprint}, the judged draft is ${fingerprint}`
    )
  }
  if (review.questionVersion !== binding.draft.reviewQuestionVersion) {
    errors.push(
      `questionVersion: the answer names version ${review.questionVersion}, the draft is reviewed under ${binding.draft.reviewQuestionVersion}`
    )
  }
  if (review.revision !== binding.draft.revision) {
    errors.push(`revision: the answer names ${review.revision}, the captured revision is ${binding.draft.revision}`)
  }
  return errors
}

const askedOfTask = (q: number): boolean => (TASK_QUESTIONS as readonly number[]).includes(q)

/** Every task has exactly one answer to each of questions 1 to 5, and the plan exactly one to question 6. */
export function completenessErrors(review: PlanReview, binding: PlanReviewBinding): string[] {
  const errors: string[] = []
  const tasks = new Set(binding.draft.tasks.map((t) => t.number))
  const seen = new Map<string, number>()
  for (const [i, a] of review.answers.entries()) {
    if (askedOfTask(a.question)) {
      if (a.task === null) {
        errors.push(`answers.${i}: question ${a.question} is asked of a task and names none`)
        continue
      }
      if (!tasks.has(a.task)) {
        errors.push(`answers.${i}: task ${a.task} is not a task of the draft`)
        continue
      }
    } else if (a.task !== null) {
      errors.push(`answers.${i}: question ${PLAN_QUESTION} is asked of the whole plan and names no task`)
      continue
    }
    const key = `${a.question}/${a.task ?? 'plan'}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
    if (a.evidence.length === 0) errors.push(`answers.${i}: question ${a.question} has no evidence`)
  }
  for (const [key, count] of seen)
    if (count > 1) errors.push(`answers: question/task ${key} is answered ${count} times`)
  for (const t of tasks) {
    for (const q of TASK_QUESTIONS) {
      if (!seen.has(`${q}/${t}`)) errors.push(`answers: task ${t} has no answer to question ${q}`)
    }
  }
  if (!seen.has(`${PLAN_QUESTION}/plan`)) errors.push(`answers: the plan has no answer to question ${PLAN_QUESTION}`)
  return errors
}

/**
 * The command forms the seat's shell refuses even though their prefix is allowed, as the grants list them:
 * `prefix ... -flag` refuses the flag anywhere after the prefix (a trailing `*` matches a longer flag), and a
 * rule without `...` refuses the prefix itself. A test binds this list to `thinking/plan-reviewer/grants.yaml`.
 */
export const PLAN_REVIEW_EVIDENCE_DENIED: readonly string[] = [
  'git push',
  'git commit',
  'git add',
  'gh',
  'bun install',
  'bun test',
  'bun run',
  'npx',
  'security',
  'launchctl',
  'defaults',
  'systemsetup',
  'networksetup',
  'pmset',
  'dscl',
  'crontab',
  'chsh',
  'git config --global',
  'git config --system',
  'sudo',
  'git -c',
  'git diff ... --output',
  'git diff ... --ext-diff',
  'git diff ... --textconv',
  'git log ... --output',
  'git log ... --ext-diff',
  'git log ... --textconv',
  'git show ... --output',
  'git show ... --ext-diff',
  'git show ... --textconv',
  'git grep ... --open-files-in-pager',
  'git grep ... -O*',
  'rg ... --pre',
  'rg ... --hostname-bin',
  'rg ... --search-zip',
  'rg ... -z'
]

/** Command substitution and backticks run code wherever they sit; a newline starts another command. */
const SHELL_EXECUTION = /[`\n]|\$\(/
/** Chaining, piping and redirection outside quotes; inside quotes they are arguments (`rg "a|b" src`). */
const SHELL_CHAINING = /[;&|<>]/
const QUOTED = /'[^']*'|"[^"]*"/g

function tokenMatchesFlag(token: string, flag: string): boolean {
  if (flag.endsWith('*')) return token.startsWith(flag.slice(0, -1))
  if (token === flag || token.startsWith(`${flag}=`)) return true
  // A short flag may sit inside a cluster (`-nz`) or carry its value attached.
  return /^-[A-Za-z]$/.test(flag) && /^-[A-Za-z]/.test(token) && token.includes(flag.slice(1))
}

function deniedByRule(command: string, rule: string): boolean {
  const [prefix, flag] = rule.split(' ... ')
  const words = command.split(/\s+/)
  const head = (prefix as string).split(' ')
  if (!head.every((word, i) => words[i] === word)) return false
  if (flag === undefined) return true
  return words.slice(head.length).some((token) => tokenMatchesFlag(token, flag))
}

/** Whether a command begins with an allowed read-only prefix, at a word boundary, uses no denied form and chains nothing. */
export function isAllowedEvidenceCommand(command: string): boolean {
  const trimmed = command.trim()
  if (SHELL_EXECUTION.test(trimmed) || SHELL_CHAINING.test(trimmed.replace(QUOTED, ''))) return false
  if (PLAN_REVIEW_EVIDENCE_DENIED.some((rule) => deniedByRule(trimmed, rule))) return false
  return PLAN_REVIEW_EVIDENCE_COMMANDS.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `))
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The text of the draft's agreed scope a passage may be quoted from: each item and each left-out reason. */
function scopeTexts(draft: PlanDraft): string[] {
  return draft.scope.flatMap((s) => [
    squash(s.item),
    ...(s.disposition.kind === 'left-out' ? [squash(s.disposition.reason)] : [])
  ])
}

/** Errors in one piece of evidence: a location that is not there, a command off the list, a foreign passage. */
export function evidenceErrors(evidence: PlanReviewEvidence, binding: PlanReviewBinding): string[] {
  switch (evidence.kind) {
    case 'code': {
      if (evidence.path === null || evidence.line === null) return ['code evidence names a path and a line']
      // A location is inside the captured revision's tree: never absolute, never climbing out of it.
      if (evidence.path.startsWith('/') || evidence.path.split('/').includes('..')) {
        return [`${evidence.path} is not a path inside the captured revision`]
      }
      const lines = binding.lineCount(evidence.path)
      if (lines === null) return [`${evidence.path} does not exist at revision ${binding.draft.revision}`]
      if (evidence.line > lines) return [`${evidence.path}:${evidence.line} is past the file's ${lines} lines`]
      return []
    }
    case 'command': {
      if (evidence.command === null || evidence.output === null) {
        return ['command evidence names a command and its output']
      }
      if (!isAllowedEvidenceCommand(evidence.command)) {
        return [`command ${JSON.stringify(evidence.command)} is not on the seat's allowed list`]
      }
      return []
    }
    case 'scope': {
      if (evidence.passage === null) return ['scope evidence names a passage']
      const passage = squash(evidence.passage)
      if (!scopeTexts(binding.draft).some((text) => text.includes(passage))) {
        return [`scope passage ${JSON.stringify(evidence.passage)} is not a passage of the draft's agreed scope`]
      }
      return []
    }
  }
}

/** Errors in every piece of evidence the answer carries, answers and findings alike. */
export function evidenceSetErrors(review: PlanReview, binding: PlanReviewBinding): string[] {
  const errors: string[] = []
  for (const [i, a] of review.answers.entries()) {
    for (const [j, e] of a.evidence.entries()) {
      for (const message of evidenceErrors(e, binding)) errors.push(`answers.${i}.evidence.${j}: ${message}`)
    }
  }
  for (const [i, f] of review.findings.entries()) {
    for (const [j, e] of f.evidence.entries()) {
      for (const message of evidenceErrors(e, binding)) errors.push(`findings.${i}.evidence.${j}: ${message}`)
    }
  }
  return errors
}

/** A finding is about a task of the draft (or none, for the whole plan) and carries evidence. */
export function findingErrors(review: PlanReview, binding: PlanReviewBinding): string[] {
  const errors: string[] = []
  const tasks = new Set(binding.draft.tasks.map((t) => t.number))
  for (const [i, f] of review.findings.entries()) {
    if (askedOfTask(f.question)) {
      if (f.task === null || !tasks.has(f.task)) {
        errors.push(`findings.${i}: a finding on question ${f.question} names a task of the draft`)
      }
    } else if (f.task !== null) {
      errors.push(`findings.${i}: a finding on question ${PLAN_QUESTION} is about the whole plan and names no task`)
    }
    if (f.evidence.length === 0) errors.push(`findings.${i}: a finding names its evidence`)
  }
  return errors
}

/**
 * The controller's whole acceptance check, in order: the shape (a finding about a question outside the
 * six is a shape failure), the binding, the findings' references, completeness, then every piece of evidence.
 * Only `ok: true` is a review.
 */
export function validatePlanReview(value: unknown, binding: PlanReviewBinding): PlanReviewValidation {
  const parsed = parsePlanReview(value)
  if (!parsed.ok) return parsed
  const review = parsed.review
  const stale = bindingErrors(review, binding)
  if (stale.length > 0) return { ok: false, reason: 'stale', errors: stale }
  const rejected = findingErrors(review, binding)
  if (rejected.length > 0) return { ok: false, reason: 'rejected', errors: rejected }
  const incomplete = completenessErrors(review, binding)
  if (incomplete.length > 0) return { ok: false, reason: 'incomplete', errors: incomplete }
  const unverified = evidenceSetErrors(review, binding)
  if (unverified.length > 0) return { ok: false, reason: 'unverified', errors: unverified }
  return { ok: true, review }
}

export type PlanVerdict = 'approved' | 'not_approved'

/**
 * The harness's verdict: approved when the answer is a review and holds no blocking finding. The answer has no
 * verdict field, so nothing the seat writes can approve a plan; an answer that is not a review is never approval.
 */
export function derivePlanVerdict(validation: PlanReviewValidation): {
  verdict: PlanVerdict
  blocking: readonly PlanReviewFinding[]
} {
  if (!validation.ok) return { verdict: 'not_approved', blocking: [] }
  const blocking = validation.review.findings.filter((f) => f.kind === 'blocking')
  return { verdict: blocking.length === 0 ? 'approved' : 'not_approved', blocking }
}
