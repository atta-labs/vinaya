import { execFileSync } from 'node:child_process'
import { formatTokenReportRow, type MeteringCapability, parsePremiseBlock } from '@attalabs/aeg-core'
import { printJson } from '../lib/envelope'
import {
  type BodyResult,
  collectBodyCheckErrors,
  ForgeArgError,
  extractTitle,
  locateBody,
  makeCheckError,
  parseIssueNumberFromRef,
  refuse,
  resolveSections,
  resolveShippableArgs,
  validateForgeWrite
} from '../lib/forge-write'
import { checkBareDigits } from '../checks/body-bare-digits-logic'
import type { CheckError } from '../checks/contract'
import { derivePhase, isoToday, resolveTokenReportCapability, writeTokensBlock } from '../lib/pr-report-engine'

const RETRY_CREATE = 'vinaya pr create --validate-only …'
const RETRY_EDIT = 'vinaya pr edit <n> --validate-only …'

// Array-form execFileSync — no shell, so a ref/filename carrying shell
// metacharacters is passed to git/gh as an inert literal argv element, never
// interpreted (same command-injection guard as check-brief-shape.ts).
function git(args: string[]): string {
  try {
    // stdin ignored, stdout captured, stderr discarded — execFileSync inherits
    // the child's stderr by default, which would leak git's "not a git
    // repository" warning into the CheckError stream when run outside a repo.
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function localChangedFiles(): string[] {
  const base = process.env.BASE_SHA || 'origin/main'
  let out = git(['diff', '--name-only', `${base}...HEAD`])
  if (!out) out = git(['diff', '--name-only', 'main...HEAD'])
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function locateBodyOrRefuse(ghArgs: string[], retryCommand: string): BodyResult | null {
  try {
    return locateBody(ghArgs)
  } catch (e) {
    if (e instanceof ForgeArgError) {
      refuse([makeCheckError('forge-args', e.message, `Fix the invocation, then re-run \`${retryCommand}\`.`)])
    }
    throw e
  }
}

function reportPass(json: boolean, command: string): void {
  if (json) {
    printJson({ validated: true, written: false, command })
  } else {
    process.stdout.write('✓ all brief-schema gates PASS — nothing written (--validate-only).\n')
  }
}

/** Returns the URL `gh` printed (empty string if it printed none) — `prCreateCommand` needs it to resolve the PR number for the brief comment post. */
function runGhWrite(ghCmd: string[], ghArgs: string[], bodyResult: BodyResult | null, json: boolean): string {
  const { finalArgs, cleanup } = resolveShippableArgs(ghArgs, bodyResult)
  try {
    const out = execFileSync('gh', [...ghCmd, ...finalArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    const url = out.trim()
    if (json) printJson({ validated: true, written: true, url })
    else if (url) process.stdout.write(`${url}\n`)
    return url
  } finally {
    cleanup()
  }
}

// --- edit-mode forge context (hard-refuse on any fetch/parse failure) --------

/**
 * Fetches the target PR's real state from the forge — its head branch (which
 * gate set applies is a property of the TARGET PR, never the local checkout)
 * and its changed files (premise coverage). A failed fetch is a HARD
 * refusal, never a fall-back to the local checkout's diff.
 */
function fetchPrForgeContext(prRef: string): { changedFiles: string[]; branch: string } {
  let viewOut: string
  try {
    viewOut = execFileSync('gh', ['pr', 'view', prRef, '--json', 'headRefName,files'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not fetch PR ${prRef} from the forge (\`gh pr view\`) — the brief-schema gate cannot resolve the target PR's state.`,
        `Check \`gh auth status\` and network, then re-run \`${RETRY_EDIT}\`. The edit is refused rather than validated against the local checkout.`
      )
    ])
  }
  let parsed: { headRefName?: string; files?: Array<{ path: string }> }
  try {
    parsed = JSON.parse(viewOut)
  } catch {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not parse \`gh pr view ${prRef}\` output.`,
        `Re-run \`${RETRY_EDIT}\`; the edit is refused rather than validated against the local checkout.`
      )
    ])
  }
  if (!parsed.headRefName) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `\`gh pr view ${prRef}\` returned no head branch — the target PR could not be resolved.`,
        `Confirm PR ${prRef} exists, then re-run \`${RETRY_EDIT}\`.`
      )
    ])
  }
  const changedFiles = (parsed.files ?? []).map((f) => f.path)

  // headRefName is already fetched and hard-validated above; returning it lets
  // `pr edit` apply the same branch grammar as `pr create` rather than
  // grading every PR body as if it were a task branch's.
  return { changedFiles, branch: parsed.headRefName ?? '' }
}

/**
 * The brief now lives on the Issue as the frozen `aeg:brief:v1` comment,
 * posted by `dispatchTask` (`lib/dispatch-task.ts`) —
 * `pr create` no longer splits a brief section out of the PR body, and never
 * posts a second copy of it as a PR comment. A body still carrying either
 * legacy marker (from a stale template, or a hand-pasted reference brief)
 * is refused outright rather than silently accepted: a PR body copying the
 * OLD split convention has already stopped matching what every reader now
 * expects to find on the Issue, and passing it through would ship a body
 * shaped for a mechanism that no longer runs.
 */
const LEGACY_BRIEF_MARKERS = ['<!-- aeg:brief:start -->', '<!-- aeg:brief:end -->']

/**
 * Line-anchored, not a whole-body substring search: the real, structural
 * marker this retires always sat alone on its own line, immediately
 * preceding `## Reference — the dispatched brief`. A body that merely
 * *describes* the retired convention in prose — this very PR's own body
 * included, wrapped in backticks — must not trip the same refusal a real
 * leftover marker does (found live authoring this task's own PR body).
 */
function hasLegacyBriefMarkerLine(body: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*${escaped}\\s*$`, 'm').test(body)
}

function legacyBriefMarkerErrors(body: string, retryCommand: string): CheckError[] {
  const found = LEGACY_BRIEF_MARKERS.filter((marker) => hasLegacyBriefMarkerLine(body, marker))
  if (found.length === 0) return []
  return [
    makeCheckError(
      'pr-brief-comment',
      `body carries the retired brief-split marker(s) (${found.join(', ')}) — the brief lives on the Issue's \`aeg:brief:v1\` comment now, never split out of the PR body.`,
      `Remove the \`## Reference\` section and its markers from the body (see \`aeg-root/templates/pr-report-template.md\`), then re-run \`${retryCommand}\`.`
    )
  ]
}

// --- commands ----------------------------------------------------------------

/**
 * Every check CI will run against this body, graded here first — O1: this
 * group's findings, never `refuse()`d on their own, fold into the SAME union
 * `pr create`/`pr edit` refuse once with, alongside `validateForgeWrite`'s
 * and the PR-body registry's own groups.
 *
 * `body-bare-digits` is `requiresOpenPr`, so the ring-0 hooks skip it — there is
 * no PR body at commit time. But there IS one here, at the moment the body is
 * written, and it is a pure function of that text. Leaving it to CI meant this
 * command reported success and the gate then failed on the forge — the wrapper
 * claiming something it had not checked.
 *
 * The other three `requiresOpenPr` checks genuinely cannot run at this point and
 * are deliberately absent: `test-plan` reads `[principal]` boxes nobody can tick
 * before the PR exists, `evidence-fresh` compares against a head SHA the PR does
 * not have yet, and `closes-n` already runs as a configured section.
 *
 * No Changesets-release exemption here, unlike the CI-side check. That check
 * proves the exemption safe by fetching the real PR's author from the forge —
 * `isChangesetsReleasePr(branch, author, expectedAuthor)` — because `branch`
 * alone is not a trust boundary (`review-gate.ts`'s own docstring: an attacker
 * can push a branch literally called `changeset-release/main`). This command
 * runs before any PR exists, so there is no author to fetch and no safe way to
 * grant the exemption here. It costs nothing: the real release PR is opened by
 * `changesets/action` directly and never passes through this command.
 */
function bareDigitsErrors(body: string, retryCommand: string): CheckError[] {
  const { violations } = checkBareDigits(body)
  return violations.map((v) =>
    makeCheckError(
      'body-bare-digits',
      `body-bare-digits: bare digit outside a fenced block, line ${v.line}: ${v.text}`,
      `Backtick the digit, move it into a fenced block, or state it as a symbol, then re-run \`${retryCommand}\`.`
    )
  )
}

/** `--base <branch>` from the passthrough `gh` args — `gh pr create`'s own target when given; the repo's conventional default otherwise (every other base-branch reference in this file already assumes `main`). */
function extractBaseBranch(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--base' || a === '-B') return args[i + 1] ?? 'main'
    if (a.startsWith('--base=')) return a.slice('--base='.length)
  }
  return 'main'
}

/** `git show <ref>:<path>` against the base branch — tries `origin/<base>` first (the ref CI/a fresh clone actually has), then the bare local name, `null` when neither resolves. Never the local worktree (that already carries this PR's own commits — the whole point of O8). */
function baseBranchFileReader(baseBranch: string): (path: string) => string | null {
  return (path: string) => {
    for (const ref of [`origin/${baseBranch}`, baseBranch]) {
      try {
        return execFileSync('git', ['show', `${ref}:${path}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        })
      } catch {
        // try the next ref
      }
    }
    return null
  }
}

/**
 * A `Premise:` pin is supposed to name a pre-existing fact —
 * something already true when the brief was authored. A `contains:` pin
 * whose target string is absent from the base branch can only be true
 * because THIS PR's own diff adds it — a self-referential premise that
 * proves nothing about the surface the brief was written against. Checked
 * against the base, never the local checkout (which already has this PR's
 * commits and would trivially pass). Only `contains:` pins are in scope —
 * `absent`/`sha256` pins ask a different question this objective doesn't
 * cover.
 */
function premiseOwnAdditionsErrors(body: string, baseBranch: string, retryCommand: string): CheckError[] {
  const contains = parsePremiseBlock(body).filter((a) => a.kind === 'contains')
  if (contains.length === 0) return []
  const readBase = baseBranchFileReader(baseBranch)
  return contains
    .filter((a) => {
      const content = readBase(a.path)
      return content === null || !content.includes(a.value)
    })
    .map((a) =>
      makeCheckError(
        'pr-premise-own-additions',
        `Premise line \`- ${a.path} contains: ${a.value}\` names a symbol absent on \`${baseBranch}\` — a Premise pins a pre-existing fact, never something only this PR's own diff adds.`,
        `Drop the pin, rephrase it to describe what \`${baseBranch}\` already has, or move the claim out of \`Premise:\` entirely, then re-run \`${retryCommand}\`.`
      )
    )
}

/**
 * The `AEG:TOKENS` row `pr create` splices into the body at
 * open — real figures on a metering-capable host, the same accepted
 * unavailable form `collectTokensAddition`'s own "any other incapable
 * reason" branch already writes (`— (${reason})` in the Agent/Model cell)
 * on every incapable host, `no-transcript-resolved` included. Never a
 * refusal: unlike `vinaya pr report --write` (a re-run is always possible),
 * `pr create` opens the PR exactly once, and `token-report`'s own
 * `missingSectionError` refuses a task PR that carries no row at all — so
 * the one outcome this function must never produce is no row.
 */
/**
 * Pure half of `tokenRowForOpen`, below — split out so the two shapes
 * (`capable`: real figures; anything else: the accepted unavailable form)
 * are directly unit-testable against a fake `MeteringCapability`, without
 * driving the real pointer/transcript resolution `resolveMeteringCapability`
 * itself performs.
 */
export function tokenReportRowForCapability(capability: MeteringCapability, phase: string, date: string): string {
  if (capability.capable) {
    return formatTokenReportRow({ phase, role: 'Developer', summary: capability.summary, date })
  }
  return formatTokenReportRow({
    phase,
    role: 'Developer',
    summary: null,
    modelOverride: `— (${capability.reason})`,
    date
  })
}

function tokenRowForOpen(): string {
  return tokenReportRowForCapability(resolveTokenReportCapability(), derivePhase(), isoToday())
}

/**
 * O1 — the ONE aggregation point `pr create`/`pr edit` both run: the
 * forge-write gates (legacy brief markers, `validateForgeWrite`'s configured
 * sections, bare digits, a Premise pin about this PR's own additions) and
 * the PR-body registry checks (`collectBodyCheckErrors`, the same
 * `validates: 'body'` run every push-hook/CI run already applies), all over
 * the same bytes, folded into one union — matching how `collectTaskIssueErrors`
 * already aggregates every group for an Issue write before refusing once.
 * `premiseBaseBranch: null` skips the Premise-own-additions group entirely
 * (`pr edit`'s title-only shape, where there is no body to check a Premise
 * pin against).
 */
async function collectPrWriteErrors(input: {
  body: string
  title: string | null
  sections: ReturnType<typeof resolveSections>
  changedFiles: string[]
  branch: string
  premiseBaseBranch: string | null
  prNumber: number | undefined
  retryCommand: string
  checkLegacyBriefMarkers: boolean
}): Promise<CheckError[]> {
  const errors: CheckError[] = []
  if (input.checkLegacyBriefMarkers) errors.push(...legacyBriefMarkerErrors(input.body, input.retryCommand))
  errors.push(
    ...validateForgeWrite({
      body: input.body,
      title: input.title,
      sections: input.sections,
      changedFiles: input.changedFiles,
      retryCommand: input.retryCommand,
      branch: input.branch
    })
  )
  errors.push(...bareDigitsErrors(input.body, input.retryCommand))
  if (input.premiseBaseBranch !== null) {
    errors.push(...premiseOwnAdditionsErrors(input.body, input.premiseBaseBranch, input.retryCommand))
  }
  errors.push(...(await collectBodyCheckErrors(input.body, input.branch, input.prNumber)))
  return errors
}

export async function prCreateCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const ghArgs = args.filter((a) => a !== '--json' && a !== '--validate-only')

  const bodyResult = locateBodyOrRefuse(ghArgs, RETRY_CREATE)
  const rawBody = bodyResult?.body ?? null
  const title = extractTitle(ghArgs)

  if (rawBody === null) {
    refuse([
      makeCheckError(
        'forge-args',
        'No `--body-file <path>` (or `--body`) argument found — the brief-schema gate needs the PR body to validate it.',
        `Add \`--body-file <path>\` (or \`--body\`), then re-run \`${RETRY_CREATE}\`.`
      )
    ])
  }

  // No split any more: the brief lives on the Issue's `aeg:brief:v1`
  // comment, never riding along inside the PR body — `body` is simply the
  // raw body every gate below grades and `gh` receives.
  const body = rawBody

  const sections = resolveSections('pr', RETRY_CREATE)
  const changedFiles = localChangedFiles()

  // The branch this PR will open from. No single git query answers this;
  // each one reports a plausible-looking branch in a state where there is
  // none. Measured on git 2.50.1 — `out`/`exit`, and `git()` above maps any
  // non-zero exit to '':
  //
  //   state     symbolic-ref --quiet --short   rev-parse --abbrev-ref
  //   normal    main            exit 0         main   exit 0
  //   detached  ''              exit 1         HEAD   exit 0    <- literal, and exit 0
  //   unborn    main            exit 0         HEAD   exit 128
  //   no repo   ''              exit 128       ''     exit 128
  //
  // `symbolic-ref` names a branch that has no commit yet (unborn);
  // `rev-parse --abbrev-ref` returns the literal string `HEAD` with a clean
  // exit 0 when detached. Taking either at face value is a fail-OPEN: the
  // value reads as an ordinary non-task branch, takes the relaxed path, and
  // for a non-brief-shaped body skips every configured section.
  //
  // So resolvable means both: HEAD is a symbolic ref AND it resolves to a
  // commit. Every other state yields '' and `validateForgeWrite` enforces
  // every section.
  const headCommit = git(['rev-parse', '--verify', '--quiet', 'HEAD'])
  const branch = headCommit === '' ? '' : git(['symbolic-ref', '--quiet', '--short', 'HEAD'])

  const errors = await collectPrWriteErrors({
    body,
    title,
    sections,
    changedFiles,
    branch,
    premiseBaseBranch: extractBaseBranch(ghArgs),
    prNumber: undefined,
    retryCommand: RETRY_CREATE,
    checkLegacyBriefMarkers: true
  })
  if (errors.length > 0) refuse(errors)

  if (validateOnly) {
    reportPass(json, 'pr create')
    return
  }
  const bodyWithTokens = writeTokensBlock(body, tokenRowForOpen())
  const finalBodyResult: BodyResult | null = bodyResult ? { ...bodyResult, body: bodyWithTokens } : null
  runGhWrite(['pr', 'create'], ghArgs, finalBodyResult, json)
}

export async function prEditCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const rest = args.filter((a) => a !== '--json' && a !== '--validate-only')

  const prRef = rest[0]
  if (!prRef || prRef.startsWith('-')) {
    refuse([
      makeCheckError(
        'forge-args',
        '`pr edit` requires the target PR number/URL as the first argument.',
        'Pass the PR number, e.g. `vinaya pr edit 123 --body-file <path>`.'
      )
    ])
  }
  const ghArgs = rest.slice(1)

  const bodyResult = locateBodyOrRefuse(ghArgs, RETRY_EDIT)
  const body = bodyResult?.body ?? null
  const title = extractTitle(ghArgs)

  if (body === null && title === null) {
    refuse([
      makeCheckError(
        'forge-args',
        '`pr edit` with neither `--body-file`/`--body` nor `--title` — nothing to validate or change.',
        `Pass a \`--body-file\`/\`--body\` or a \`--title\`, then re-run \`${RETRY_EDIT}\`.`
      )
    ])
  }

  const sections = resolveSections('pr', RETRY_EDIT)
  let changedFiles: string[] = []
  let branch = ''
  if (body !== null) {
    const ctx = fetchPrForgeContext(prRef)
    changedFiles = ctx.changedFiles
    branch = ctx.branch
  }

  const errors =
    body === null
      ? validateForgeWrite({ body: '', title, sections: [], changedFiles, retryCommand: RETRY_EDIT, branch })
      : await collectPrWriteErrors({
          body,
          title,
          sections,
          changedFiles,
          branch,
          premiseBaseBranch: null,
          prNumber: parseIssueNumberFromRef(prRef) ?? undefined,
          retryCommand: RETRY_EDIT,
          checkLegacyBriefMarkers: false
        })
  if (errors.length > 0) refuse(errors)

  if (validateOnly) {
    reportPass(json, 'pr edit')
    return
  }
  runGhWrite(['pr', 'edit', prRef], ghArgs, bodyResult, json)
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'pr create': { date: '2026-09-14', callsToday: 13, retiresVia: 'forgeWrite' },
  'pr edit': { date: '2026-09-11', callsToday: 10, retiresVia: 'forgeWrite' }
}
