/**
 * The Milestone operations as a library: create, edit, adopt, close, status
 * and delete. Each returns an outcome — the Milestone written or read, or the
 * findings that refused it — and never ends the process: the
 * `vinaya milestone …` commands parse argv, call one operation here and print
 * the outcome. Every refusal reached beneath an operation (however deep) is
 * captured as a finding, not an exit.
 *
 * Create, edit, adopt, close and status keep the transport the commands always
 * used (`gh api` for single objects, `gh issue …` for Issue lists). Delete is
 * the one operation on the forge's REST API, including its listing of every
 * Issue and pull request attached to the Milestone.
 */

import { execFileSync } from 'node:child_process'
import { detectGitRepo } from '../../../../kernel/connectors/git/detect.js'
import type { CheckError } from '../../../../kernel/gates/checks/contract'
import {
  declaredTranches,
  milestoneCloseDecision,
  type TrancheLifecycle
} from '../../retrospecting/archivist/milestone-close-hold.js'
import {
  captureRefusal,
  makeCheckError,
  refuse,
  resolveSections,
  validateForgeWrite
} from '../task-contract/forge/forge-write.js'
import { deriveTrancheFromForge, trancheFromIssues } from '../task-contract/forge/derive-from-forge'
import {
  findMilestoneForSlug,
  hasTrancheIntentsSection,
  intentLines,
  resolveMilestoneAttachTarget
} from '../task-contract/forge/fetch-milestone'
import { trancheLabel } from '../task-contract/forge/labels'
import { fetchTrancheIssuesAsync } from '../task-contract/forge/list-tasks'
import {
  type AdoptFacts,
  type AdoptSlugFacts,
  type AdoptTargetFacts,
  checkAdoptable,
  checkMilestoneShape
} from '../task-contract/milestone-validation'
import { checkMilestoneAttachment } from './check-milestone-attachment'

export const RETRY_CREATE = 'vinaya milestone create --title <title> --body-file <path>'
export const RETRY_ADOPT = 'vinaya milestone adopt --target <title> --slug <slug> [--slug <slug> ...]'
export const RETRY_EDIT = 'vinaya milestone edit <n> --body-file <path>'
export const RETRY_CLOSE = 'vinaya milestone close --slug <slug>'
export const RETRY_STATUS = 'vinaya milestone status <n>'
export const RETRY_DELETE = 'the Milestone delete operation'

// --- outcomes ----------------------------------------------------------------

/**
 * What a refused operation returns: the findings, in the order the gate
 * produced them. `partialWrite` is set instead when an adopt write failed
 * after every gate passed — some writes may already have landed.
 */
export type Refused = { ok: false; findings: CheckError[]; partialWrite?: string }

export type MilestoneWritten = { number: number; url: string }

/** `written: false` is a `--validate-only` pass. */
export type MilestoneWriteOutcome =
  | { ok: true; written: false }
  | ({ ok: true; written: true } & MilestoneWritten)
  | Refused

export type AdoptedSlug = { slug: string; issueCount: number; closedMilestone: number | null }

export type AdoptOutcome =
  | { ok: true; written: false }
  | { ok: true; written: true; target: string; adopted: AdoptedSlug[] }
  | Refused

export type CloseOutcome =
  | { ok: true; written: false; number: number; title: string }
  | ({ ok: true; written: true } & MilestoneWritten)
  | Refused

export type StatusIssueCounts = { merged: number; open: number; notPlanned: number }
export type StatusRow = { slug: string; lifecycle: string; issues: number; counts: StatusIssueCounts }
export type StatusOutcome =
  | {
      ok: true
      milestone: { number: number; title: string; state: 'open' | 'closed' }
      tranches: StatusRow[]
    }
  | Refused

/** One Issue or pull request attached to a Milestone. */
export type AttachedItem = { number: number; kind: 'issue' | 'pull request'; state: string; title: string }

export type DeleteOutcome = { ok: true; deleted: true; number: number } | Refused

// --- the forge seam ----------------------------------------------------------

/** What the operations reach the forge through, replaceable so a test stubs it. */
export interface MilestoneForge {
  /** Runs one command (`gh …`), returning its trimmed stdout; throws as `execFileSync` does. */
  sh(args: string[], input?: string): string
  resolveRepo(): Promise<{ owner?: string; repo?: string } | null | undefined>
  fetchTrancheIssues: typeof fetchTrancheIssuesAsync
  findMilestoneFacts: typeof findMilestoneForSlug
  deriveLifecycle(owner: string, repo: string, slug: string): Promise<TrancheLifecycle>
}

function realSh(args: string[], input?: string): string {
  // `env: process.env` is explicit, not redundant: Bun's `execFileSync`
  // snapshots the environment at process start rather than re-reading
  // `process.env` at call time.
  //
  // `stdio: ['pipe', 'pipe', 'pipe']` is explicit too: without it Bun's
  // `execFileSync` inherits the child's stderr to this process's real stderr
  // at spawn time, so a failing `gh` call leaked its raw error text as an
  // extra, non-JSON line ahead of the finding — breaking the "one JSON line
  // per finding on stderr" contract. stdin stays a pipe because create and
  // edit send a JSON body through it.
  return execFileSync(args[0] as string, args.slice(1), {
    encoding: 'utf8',
    input,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

export const realMilestoneForge: MilestoneForge = {
  sh: realSh,
  resolveRepo: () => detectGitRepo(),
  fetchTrancheIssues: fetchTrancheIssuesAsync,
  findMilestoneFacts: findMilestoneForSlug,
  deriveLifecycle: async (owner, repo, slug) => (await deriveTrancheFromForge(owner, repo, slug)).lifecycle
}

// --- helpers -----------------------------------------------------------------

type GhLabelEntry = { name: string }
type GhMilestoneEntry = { number: number; title: string; description: string | null; state: 'open' | 'closed' }
type GhIssueRef = { number: number; state: 'OPEN' | 'CLOSED'; milestone: { title: string } | null }

function shJson<T>(forge: MilestoneForge, args: string[], input?: string): T {
  return JSON.parse(forge.sh(args, input)) as T
}

/**
 * `execFileSync`'s thrown `.message` is `"Command failed: <the whole argv>\n<stderr>"`
 * — `gh`'s actual diagnostic is never on the first line. Prefers `.stderr`
 * (what `gh` actually wrote) when present, falling back to the full message.
 */
export function ghErrorDetail(e: unknown): string {
  const stderr = (e as { stderr?: Buffer | string })?.stderr
  const text = typeof stderr === 'string' ? stderr : stderr?.toString()
  return (text && text.trim().length > 0 ? text : ((e as Error)?.message ?? 'unknown error')).trim()
}

/** Is this failure just "no such Milestone", not a genuine forge-unreachable error? Scans the whole message plus stderr. */
function is404(e: unknown): boolean {
  const stderr = (e as { stderr?: Buffer | string })?.stderr
  const haystack = [(e as Error)?.message ?? '', typeof stderr === 'string' ? stderr : (stderr?.toString() ?? '')].join(
    '\n'
  )
  return /\b404\b|not found/i.test(haystack)
}

/** Runs an operation with every refusal beneath it captured as findings. */
async function outcomeOf<T>(fn: () => Promise<T | Refused>): Promise<T | Refused> {
  const result = await captureRefusal(fn)
  return result.ok ? result.value : { ok: false, findings: result.errors }
}

/** The Milestone number is interpolated into a REST path, so anything but digits is refused inside the library, whoever calls it. */
function refuseUnlessDigits(number: string, retryCommand: string): void {
  if (!/^\d+$/.test(number)) {
    refuse([
      makeCheckError(
        'forge-args',
        'A Milestone number is digits only.',
        `Pass the Milestone number, then re-run \`${retryCommand}\`.`
      )
    ])
  }
}

/** `checkMilestoneShape` refusal — unconditional; config decides which EXTRA sections are required, never whether THIS runs. */
function refuseOnBadShape(body: string, retryCommand: string): void {
  const shape = checkMilestoneShape(body)
  if (shape.status === 'fail') {
    refuse(
      shape.errors.map((message) =>
        makeCheckError('milestone-shape', message, `Fix the Milestone description, then re-run \`${retryCommand}\`.`)
      )
    )
  }
}

/** The config-defined `briefSchema.milestone` sections gate — `title: null`, a Milestone's title is free text. */
function refuseOnSchemaErrors(body: string, retryCommand: string): void {
  const sections = resolveSections('milestone', retryCommand)
  const schemaErrors = validateForgeWrite({ body, title: null, sections, changedFiles: [], retryCommand })
  if (schemaErrors.length > 0) refuse(schemaErrors)
}

async function resolveRepoFlagOrRefuse(forge: MilestoneForge, retryCommand: string): Promise<string> {
  const repo = await forge.resolveRepo()
  if (!repo?.owner || !repo.repo) {
    refuse([
      makeCheckError(
        'forge-fetch',
        'Could not resolve a GitHub owner/repo from the `origin` remote.',
        `Run this command from inside a git repository whose \`origin\` remote points at GitHub, then re-run \`${retryCommand}\`.`
      )
    ])
  }
  return `${repo.owner}/${repo.repo}`
}

/** A failed forge READ, before any refusal has run. */
function ghJsonOrRefuse<T>(forge: MilestoneForge, args: string[], what: string, retryCommand: string): T {
  try {
    return shJson<T>(forge, args)
  } catch (e) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `could not fetch ${what} from the forge: ${ghErrorDetail(e)}`,
        `Check \`gh auth status\` and network, then re-run \`${retryCommand}\`.`
      )
    ])
  }
}

// --- create / edit -----------------------------------------------------------

export async function createMilestone(
  input: { title: string; body: string; validateOnly: boolean },
  forge: MilestoneForge = realMilestoneForge
): Promise<MilestoneWriteOutcome> {
  return outcomeOf(async () => {
    const { title, body } = input
    refuseOnBadShape(body, RETRY_CREATE)
    refuseOnSchemaErrors(body, RETRY_CREATE)
    if (input.validateOnly) return { ok: true as const, written: false as const }

    const repoFlag = await resolveRepoFlagOrRefuse(forge, RETRY_CREATE)

    let out: string
    try {
      out = forge.sh(
        ['gh', 'api', `repos/${repoFlag}/milestones`, '--input', '-'],
        JSON.stringify({ title, description: body })
      )
    } catch (e) {
      refuse([
        makeCheckError(
          'forge-fetch',
          `\`gh api repos/${repoFlag}/milestones\` failed: ${ghErrorDetail(e)}`,
          `Check \`gh auth status\` and network, then re-run \`${RETRY_CREATE}\`.`
        )
      ])
    }

    const created = JSON.parse(out) as { number: number; html_url: string }
    return { ok: true as const, written: true as const, number: created.number, url: created.html_url }
  })
}

export async function editMilestone(
  input: { number: string; body: string; validateOnly: boolean },
  forge: MilestoneForge = realMilestoneForge
): Promise<MilestoneWriteOutcome> {
  return outcomeOf(async () => {
    const { number, body } = input
    refuseUnlessDigits(number, RETRY_EDIT)
    refuseOnBadShape(body, RETRY_EDIT)
    refuseOnSchemaErrors(body, RETRY_EDIT)
    if (input.validateOnly) return { ok: true as const, written: false as const }

    const repoFlag = await resolveRepoFlagOrRefuse(forge, RETRY_EDIT)

    let out: string
    try {
      out = forge.sh(
        ['gh', 'api', '-X', 'PATCH', `repos/${repoFlag}/milestones/${number}`, '--input', '-'],
        JSON.stringify({ description: body })
      )
    } catch (e) {
      refuse([
        makeCheckError(
          'forge-fetch',
          `\`gh api repos/${repoFlag}/milestones/${number}\` failed: ${ghErrorDetail(e)}`,
          `Check \`gh auth status\` and network, then re-run \`${RETRY_EDIT}\`.`
        )
      ])
    }

    const edited = JSON.parse(out) as { number: number; html_url: string }
    return { ok: true as const, written: true as const, number: edited.number, url: edited.html_url }
  })
}

// --- adopt -------------------------------------------------------------------

/**
 * Every fact `checkAdoptable` needs, for every requested slug, gathered
 * BEFORE the first refusal is evaluated — no write happens until this
 * returns and `checkAdoptable` passes over the whole result. The Milestone
 * snapshot is returned alongside the facts so the write phase reuses it.
 */
function fetchAdoptFacts(
  forge: MilestoneForge,
  repoFlag: string,
  target: string,
  slugs: string[]
): { facts: AdoptFacts; milestones: GhMilestoneEntry[] } {
  const labels = ghJsonOrRefuse<GhLabelEntry[]>(
    forge,
    ['gh', 'api', `repos/${repoFlag}/labels?per_page=100`],
    "this repo's labels",
    RETRY_ADOPT
  )
  const milestones = ghJsonOrRefuse<GhMilestoneEntry[]>(
    forge,
    ['gh', 'api', `repos/${repoFlag}/milestones?state=all&per_page=100`],
    "this repo's Milestones",
    RETRY_ADOPT
  )

  const targetMilestone = milestones.find((m) => m.title === target)
  const targetFacts: AdoptTargetFacts = {
    title: target,
    exists: !!targetMilestone,
    state: targetMilestone?.state ?? null
  }

  const slugFacts: AdoptSlugFacts[] = slugs.map((slug) => {
    const labelExists = labels.some((l) => l.name === trancheLabel(slug))
    const issues = labelExists
      ? ghJsonOrRefuse<GhIssueRef[]>(
          forge,
          [
            'gh',
            'issue',
            'list',
            '-R',
            repoFlag,
            '--label',
            trancheLabel(slug),
            '--state',
            'all',
            '--json',
            'number,state,milestone',
            '--limit',
            '200'
          ],
          `Issues for \`${trancheLabel(slug)}\``,
          RETRY_ADOPT
        )
      : []

    // "Adopted elsewhere" excludes null (never attached), the slug itself
    // (its own legacy 1:1 tranche-Milestone), and the requested target.
    const elsewhere = new Set<string>()
    for (const issue of issues) {
      const title = issue.milestone?.title
      if (title && title !== slug && title !== target) elsewhere.add(title)
    }

    return {
      slug,
      labelExists,
      issueNumbers: issues.map((i) => i.number),
      adoptedElsewhere: [...elsewhere]
    }
  })

  return { facts: { target: targetFacts, slugs: slugFacts }, milestones }
}

/**
 * A write-phase failure — distinct from a refusal, which always means
 * "nothing reached the forge." By the time this can fire, `checkAdoptable`
 * has passed and some writes may have landed. Every write is idempotent, so
 * the recovery is re-running the identical `adopt` invocation.
 */
function partialWrite(message: string): Refused {
  return { ok: false, findings: [], partialWrite: message }
}

export async function adoptMilestone(
  input: { target: string; slugs: string[]; validateOnly: boolean },
  forge: MilestoneForge = realMilestoneForge
): Promise<AdoptOutcome> {
  return outcomeOf(async (): Promise<AdoptOutcome> => {
    const { target, slugs } = input
    const repoFlag = await resolveRepoFlagOrRefuse(forge, RETRY_ADOPT)

    // ---- gather everything -----------------------------------------------
    const { facts, milestones } = fetchAdoptFacts(forge, repoFlag, target, slugs)

    // ---- refuse or proceed — one call over the WHOLE batch ----------------
    const verdict = checkAdoptable(facts)
    if (verdict.status === 'fail') {
      refuse(
        verdict.errors.map((message) =>
          makeCheckError('milestone-adopt', message, `Fix the input above, then re-run \`${RETRY_ADOPT}\`.`)
        )
      )
    }

    if (input.validateOnly) return { ok: true, written: false }

    // ---- then write — never before every refusal above has run -----------
    const adopted: AdoptedSlug[] = []
    for (const slugFact of facts.slugs) {
      for (const issueNumber of slugFact.issueNumbers) {
        try {
          forge.sh(['gh', 'issue', 'edit', String(issueNumber), '-R', repoFlag, '--milestone', target])
        } catch (e) {
          return partialWrite(
            `failed to attach Issue #${issueNumber} (tranche \`${slugFact.slug}\`) to Milestone "${target}": ` +
              `${ghErrorDetail(e)}. Slugs already adopted this run: ${adopted.map((a) => a.slug).join(', ') || '(none)'}.`
          )
        }
      }

      const legacy = milestones.find((m) => m.title === slugFact.slug && m.title !== target)
      let closedMilestone: number | null = null
      if (legacy) {
        closedMilestone = legacy.number
        if (legacy.state !== 'closed') {
          try {
            forge.sh([
              'gh',
              'api',
              '-X',
              'PATCH',
              `repos/${repoFlag}/milestones/${legacy.number}`,
              '-f',
              'state=closed'
            ])
          } catch (e) {
            return partialWrite(
              `attached tranche \`${slugFact.slug}\`'s Issue(s) to Milestone "${target}", but failed to close its old ` +
                `Milestone #${legacy.number}: ${ghErrorDetail(e)}. Slugs already adopted this run: ` +
                `${adopted.map((a) => a.slug).join(', ') || '(none)'}.`
            )
          }
        }
      }

      adopted.push({ slug: slugFact.slug, issueCount: slugFact.issueNumbers.length, closedMilestone })
    }

    return { ok: true, written: true, target, adopted }
  })
}

// --- close -------------------------------------------------------------------

export async function closeMilestone(
  input: { slug: string; validateOnly: boolean },
  forge: MilestoneForge = realMilestoneForge
): Promise<CloseOutcome> {
  return outcomeOf(async (): Promise<CloseOutcome> => {
    const { slug } = input
    const repoFlag = await resolveRepoFlagOrRefuse(forge, RETRY_CLOSE)

    // ---- resolve the target Milestone — the same legacy-or-intent-declared
    // match `resolveMilestoneAttachTarget` applies at Issue-create time. ----
    const milestones = ghJsonOrRefuse<GhMilestoneEntry[]>(
      forge,
      ['gh', 'api', `repos/${repoFlag}/milestones?state=all&per_page=100`],
      "this repo's Milestones",
      RETRY_CLOSE
    )

    const target = resolveMilestoneAttachTarget(milestones, slug)
    if (!target) {
      refuse([
        makeCheckError(
          'milestone-close',
          `No OPEN Milestone resolves for tranche \`${slug}\` — it may already be closed, or never had one attached.`,
          `Confirm with \`gh issue list --label ${trancheLabel(slug)} --json milestone\`, or run \`vinaya milestone ` +
            `create\`/\`${RETRY_ADOPT}\` if a Milestone is genuinely still owed, then re-run \`${RETRY_CLOSE}\`.`
        )
      ])
    }

    // ---- gather the two facts the pure function diffs ----
    const labeledIssues = ghJsonOrRefuse<GhIssueRef[]>(
      forge,
      [
        'gh',
        'issue',
        'list',
        '-R',
        repoFlag,
        '--label',
        trancheLabel(slug),
        '--state',
        'all',
        '--json',
        'number,state,milestone',
        '--limit',
        '200'
      ],
      `Issues for \`${trancheLabel(slug)}\``,
      RETRY_CLOSE
    )

    const attachedIssues = ghJsonOrRefuse<GhIssueRef[]>(
      forge,
      [
        'gh',
        'issue',
        'list',
        '-R',
        repoFlag,
        '--milestone',
        target.title,
        '--state',
        'all',
        '--json',
        'number,state,milestone',
        '--limit',
        '200'
      ],
      `Issues attached to Milestone "${target.title}"`,
      RETRY_CLOSE
    )

    const report = checkMilestoneAttachment(
      labeledIssues.map((i) => i.number),
      attachedIssues.map((i) => i.number)
    )

    // ---- refuse on any mismatch, naming the repair path — BEFORE the PATCH. ----
    if (report.status === 'mismatch') {
      const errors = []
      if (report.unattached.length > 0) {
        errors.push(
          makeCheckError(
            'milestone-close',
            `Issue(s) ${report.unattached.map((n) => `#${n}`).join(', ')} carry \`${trancheLabel(slug)}\` but ` +
              `are not attached to Milestone "${target.title}".`,
            `Attach each with \`gh issue edit <n> --milestone "${target.title}"\`, then re-run \`${RETRY_CLOSE}\`.`
          )
        )
      }
      if (report.foreign.length > 0) {
        errors.push(
          makeCheckError(
            'milestone-close',
            `Issue(s) ${report.foreign.map((n) => `#${n}`).join(', ')} are attached to Milestone "${target.title}" ` +
              `but do not carry \`${trancheLabel(slug)}\` — closing would end tracking for whatever they belong to as well.`,
            `Move them with \`${RETRY_ADOPT}\` if they belong to a different tranche, or \`gh issue edit <n> ` +
              `--milestone <title>\` to relocate them, then re-run \`${RETRY_CLOSE}\`.`
          )
        )
      }
      refuse(errors)
    }

    // ---- the declared-tranche hold — the same decision `vinaya archive
    // tranche` makes, decided before the dry-run branch so a dry run refuses
    // with the same reasons. ----
    const closingLifecycle: TrancheLifecycle =
      labeledIssues.length === 0 ? 'planned' : labeledIssues.some((i) => i.state === 'OPEN') ? 'active' : 'complete'
    const description = milestones.find((m) => m.number === target.number)?.description ?? ''
    const [owner = '', repoName = ''] = repoFlag.split('/')
    let declared: Awaited<ReturnType<typeof declaredTranches>>
    try {
      declared = await declaredTranches(description, async (declaredSlug) =>
        declaredSlug === slug ? closingLifecycle : await forge.deriveLifecycle(owner, repoName, declaredSlug)
      )
    } catch (e) {
      refuse([
        makeCheckError(
          'forge-fetch',
          `could not read a declared tranche's lifecycle from the forge: ${ghErrorDetail(e)}`,
          `Check \`gh auth status\` and network, then re-run \`${RETRY_CLOSE}\`.`
        )
      ])
    }
    const verdict = milestoneCloseDecision({
      otherWorkOpen: false,
      declaresIntents: hasTrancheIntentsSection(description),
      declared
    })
    if (!verdict.close) {
      refuse(
        verdict.reasons.map((reason) =>
          makeCheckError(
            'milestone-close',
            `Milestone "${target.title}" must stay open: ${reason}.`,
            `Finish the declared work, then re-run \`${RETRY_CLOSE}\`.`
          )
        )
      )
    }

    if (input.validateOnly) return { ok: true, written: false, number: target.number, title: target.title }

    // ---- then write — never before every refusal above has run ----
    let out: string
    try {
      out = forge.sh([
        'gh',
        'api',
        '-X',
        'PATCH',
        `repos/${repoFlag}/milestones/${target.number}`,
        '-f',
        'state=closed'
      ])
    } catch (e) {
      refuse([
        makeCheckError(
          'forge-fetch',
          `\`gh api repos/${repoFlag}/milestones/${target.number}\` failed: ${ghErrorDetail(e)}`,
          `Check \`gh auth status\` and network, then re-run \`${RETRY_CLOSE}\`.`
        )
      ])
    }

    const closed = JSON.parse(out) as { number: number; html_url: string }
    return { ok: true, written: true, number: closed.number, url: closed.html_url }
  })
}

// --- status ------------------------------------------------------------------

function tallyIssueCounts(issues: Array<{ state: 'OPEN' | 'CLOSED'; stateReason?: string | null }>): StatusIssueCounts {
  const counts: StatusIssueCounts = { merged: 0, open: 0, notPlanned: 0 }
  for (const issue of issues) {
    if (issue.state === 'OPEN') counts.open++
    else if (issue.stateReason === 'NOT_PLANNED') counts.notPlanned++
    else counts.merged++
  }
  return counts
}

/** Read-only: each declared tranche's lifecycle and Issue counts, derived from the forge. Nothing is written. */
export async function milestoneStatus(
  input: { number: string },
  forge: MilestoneForge = realMilestoneForge
): Promise<StatusOutcome> {
  return outcomeOf(async (): Promise<StatusOutcome> => {
    const numberArg = input.number
    refuseUnlessDigits(numberArg, RETRY_STATUS)
    const repoFlag = await resolveRepoFlagOrRefuse(forge, RETRY_STATUS)
    const [owner, repo] = repoFlag.split('/') as [string, string]

    let milestone: GhMilestoneEntry
    try {
      milestone = shJson<GhMilestoneEntry>(forge, ['gh', 'api', `repos/${repoFlag}/milestones/${numberArg}`])
    } catch (e) {
      if (is404(e)) {
        refuse([
          makeCheckError(
            'milestone-status',
            `Milestone #${numberArg} is not an open-or-closed Milestone in ${repoFlag}.`,
            `Confirm the number with \`gh api repos/${repoFlag}/milestones\`, then re-run \`${RETRY_STATUS}\`.`
          )
        ])
      }
      refuse([
        makeCheckError(
          'forge-fetch',
          `could not fetch Milestone #${numberArg} from the forge: ${ghErrorDetail(e)}`,
          `Check \`gh auth status\` and network, then re-run \`${RETRY_STATUS}\`.`
        )
      ])
    }

    const header = { number: milestone.number, title: milestone.title, state: milestone.state }
    const intents = intentLines(milestone.description ?? '')
    if (intents.length === 0) return { ok: true, milestone: header, tranches: [] }

    const rows: StatusRow[] = []
    for (const intent of intents) {
      let issues: Awaited<ReturnType<typeof fetchTrancheIssuesAsync>>
      try {
        issues = await forge.fetchTrancheIssues(owner, repo, intent.slug)
      } catch (e) {
        refuse([
          makeCheckError(
            'forge-fetch',
            `could not fetch tranche \`${intent.slug}\`'s Issues from the forge: ${ghErrorDetail(e)}`,
            `Check \`gh auth status\` and network, then re-run \`${RETRY_STATUS}\`.`
          )
        ])
      }
      let milestoneFacts: ReturnType<typeof findMilestoneForSlug>
      try {
        milestoneFacts = forge.findMilestoneFacts(owner, repo, intent.slug)
      } catch (e) {
        refuse([
          makeCheckError(
            'forge-fetch',
            `could not derive tranche \`${intent.slug}\`'s Milestone facts from the forge: ${ghErrorDetail(e)}`,
            `Check \`gh auth status\` and network, then re-run \`${RETRY_STATUS}\`.`
          )
        ])
      }
      const tranche = trancheFromIssues(intent.slug, issues, milestoneFacts)
      rows.push({
        slug: intent.slug,
        lifecycle: tranche.lifecycle,
        issues: issues.length,
        counts: tallyIssueCounts(issues)
      })
    }

    return { ok: true, milestone: header, tranches: rows }
  })
}

// --- delete ------------------------------------------------------------------

/**
 * Every top-level JSON array in `text`, concatenated — `gh api --paginate`
 * prints one array per page (or one merged array), and either shape must read
 * back as the same list. Returns `null` for anything that is not a run of
 * arrays, so the caller refuses rather than guessing.
 */
export function parsePagedArrays(text: string): unknown[] | null {
  const items: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      if (depth === 0) return null
      inString = true
    } else if (c === '[' || c === '{') {
      if (depth === 0) {
        if (c !== '[') return null
        start = i
      }
      depth++
    } else if (c === ']' || c === '}') {
      depth--
      if (depth < 0) return null
      if (depth === 0) {
        try {
          const page = JSON.parse(text.slice(start, i + 1)) as unknown
          if (!Array.isArray(page)) return null
          items.push(...page)
        } catch {
          return null
        }
      }
    } else if (depth === 0 && !/\s/.test(c)) {
      return null
    }
  }
  return depth === 0 && !inString ? items : null
}

const recoveryFor = (detail: string) => `${detail}, then re-run ${RETRY_DELETE}.`

/**
 * Deletes a Milestone by number only when it exists and nothing — no Issue,
 * no pull request, open or closed — is attached to it. Any doubt (a failed
 * read, an unreadable listing, fewer items listed than the Milestone counts)
 * refuses; the Milestone is never deleted on a guess.
 */
export async function deleteMilestone(
  input: { number: string },
  forge: MilestoneForge = realMilestoneForge
): Promise<DeleteOutcome> {
  return outcomeOf(async (): Promise<DeleteOutcome> => {
    const { number } = input
    if (!/^\d+$/.test(number)) {
      refuse([
        makeCheckError(
          'forge-args',
          'Deleting a Milestone requires its number, digits only.',
          recoveryFor('Pass the Milestone number')
        )
      ])
    }
    const repoFlag = await resolveRepoFlagOrRefuse(forge, RETRY_DELETE)

    // ---- the Milestone must exist ----
    let milestone: { number: number; open_issues?: number; closed_issues?: number }
    try {
      milestone = shJson(forge, ['gh', 'api', `repos/${repoFlag}/milestones/${number}`])
    } catch (e) {
      if (is404(e)) {
        refuse([
          makeCheckError(
            'milestone-delete',
            `Milestone #${number} does not exist in ${repoFlag}, so there is nothing to delete.`,
            recoveryFor(`Confirm the number with \`gh api repos/${repoFlag}/milestones?state=all\``)
          )
        ])
      }
      refuse([
        makeCheckError(
          'forge-fetch',
          `could not fetch Milestone #${number} from the forge: ${ghErrorDetail(e)}`,
          recoveryFor('Check `gh auth status` and network')
        )
      ])
    }

    // ---- every Issue and pull request attached, open or closed, every page ----
    let raw: string
    try {
      raw = forge.sh(['gh', 'api', '--paginate', `repos/${repoFlag}/issues?milestone=${number}&state=all&per_page=100`])
    } catch (e) {
      refuse([
        makeCheckError(
          'forge-fetch',
          `could not list the items attached to Milestone #${number}: ${ghErrorDetail(e)}`,
          recoveryFor('Check `gh auth status` and network')
        )
      ])
    }
    const listed = parsePagedArrays(raw)
    if (listed === null) {
      refuse([
        makeCheckError(
          'milestone-delete',
          `The forge's listing of the items attached to Milestone #${number} could not be read, so nothing proves it is empty.`,
          recoveryFor('Check `gh auth status` and network')
        )
      ])
    }

    const items: AttachedItem[] = []
    for (const entry of listed) {
      const e = entry as { number?: unknown; state?: unknown; title?: unknown; pull_request?: unknown }
      if (typeof e.number !== 'number') {
        refuse([
          makeCheckError(
            'milestone-delete',
            `The forge's listing of the items attached to Milestone #${number} held an entry without a number, so nothing proves it is empty.`,
            recoveryFor('Check `gh auth status` and network')
          )
        ])
      }
      items.push({
        number: e.number,
        kind: e.pull_request ? 'pull request' : 'issue',
        state: String(e.state ?? 'unknown'),
        title: String(e.title ?? '')
      })
    }

    if (items.length > 0) {
      refuse([
        makeCheckError(
          'milestone-delete',
          `Milestone #${number} has ${items.length} attached item(s) and must not be deleted: ` +
            items.map((i) => `#${i.number} (${i.kind}, ${i.state}) ${i.title}`.trim()).join('; ') +
            '.',
          recoveryFor('Move each attached item to another Milestone, or keep this one as the record of its history')
        )
      ])
    }

    // The Milestone's own counts must agree that nothing is attached.
    const counted = (milestone.open_issues ?? 0) + (milestone.closed_issues ?? 0)
    if (counted > 0) {
      refuse([
        makeCheckError(
          'milestone-delete',
          `Milestone #${number} counts ${counted} attached item(s) the listing did not return, so nothing proves it is empty.`,
          recoveryFor('Check the Milestone on the forge')
        )
      ])
    }

    try {
      forge.sh(['gh', 'api', '-X', 'DELETE', `repos/${repoFlag}/milestones/${number}`])
    } catch (e) {
      refuse([
        makeCheckError(
          'forge-fetch',
          `\`gh api -X DELETE repos/${repoFlag}/milestones/${number}\` failed: ${ghErrorDetail(e)}`,
          recoveryFor('Check `gh auth status` and network')
        )
      ])
    }
    return { ok: true, deleted: true, number: Number(number) }
  })
}
