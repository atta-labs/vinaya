import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authoredRegionHash, renderBodyHashMarker } from '@attalabs/aeg-core'
import { printJson } from '../lib/envelope'
import {
  type BodyResult,
  ForgeArgError,
  extractTitle,
  locateBody,
  makeCheckError,
  refuse,
  resolveSections,
  resolveShippableArgs,
  validateForgeWrite
} from '../lib/forge-write'
import { checkBareDigits } from '../checks/body-bare-digits-logic'
import { coreCheckRegistry } from '../checks/registry'
import { defaultParallelism, runChecks } from '../checks/runner'
import { loadConfigChecked } from '../lib/config'

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

/** Returns the URL `gh` printed (empty string if it printed none) — `prCreateCommand` needs it to resolve the PR number for the body-hash marker post. */
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

/**
 * `pr create`'s frozen-body marker (task 5, #378): posts
 * `<!-- aeg:body-hash:<hex> -->` — the hash of `authoredRegion(body)`, the
 * exact body just sent to `gh pr create` — as a PR comment under the same
 * `gh` login that opened the PR. `pr-body-frozen` (the CI check) re-reads
 * this comment and refuses any later edit to the authored region.
 *
 * A failed post is a HARD refusal (never silent): without the marker this
 * PR is un-checkable and would silently take the `info`/grandfathered path
 * forever, which is indistinguishable from the check having never run.
 */
function postBodyHashMarker(url: string, body: string): void {
  const match = /\/pull\/(\d+)/.exec(url)
  if (!match) {
    refuse([
      makeCheckError(
        'pr-body-frozen',
        `PR was created (${url || '(gh printed no URL)'}) but its number could not be parsed from the URL, so the aeg:body-hash marker comment was not posted.`,
        'Manually post `<!-- aeg:body-hash:<hex> -->` (compute the hex via `authoredRegionHash` from `@attalabs/aeg-core` against the exact body just sent) as a PR comment, then re-run any `pr-body-frozen` check by hand.'
      )
    ])
  }
  const prNumber = match[1] as string
  const marker = renderBodyHashMarker(authoredRegionHash(body))
  const tmp = join(tmpdir(), `vinaya-pr-create-body-hash-${process.pid}-${Date.now()}.md`)
  writeFileSync(tmp, marker)
  try {
    execFileSync('gh', ['pr', 'comment', prNumber, '--body-file', tmp], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    refuse([
      makeCheckError(
        'pr-body-frozen',
        `PR ${url} was created but posting its aeg:body-hash marker comment failed: ${err instanceof Error ? err.message : String(err)}`,
        `Post the comment manually: \`gh pr comment ${prNumber} --body "${marker}"\`, then confirm with \`gh pr view ${prNumber} --json comments\`.`
      )
    ])
  } finally {
    rmSync(tmp, { force: true })
  }
}

// --- edit-mode forge context (hard-refuse on any fetch/parse failure) --------

/**
 * Fetches the target PR's real state from the forge — its head branch (which
 * gate set applies is a property of the TARGET PR, never the local checkout —
 * #417) and its changed files (premise coverage). A failed fetch is a HARD
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
 * `pr create`'s brief/report split (task 4, #397): `aeg-root/templates/
 * pr-report-template.md`'s `## Reference — the dispatched brief` section,
 * wrapped in `<!-- aeg:brief:start -->` / `<!-- aeg:brief:end -->` markers,
 * is never sent to the forge as body text — PR `#396`'s body was `47` KB,
 * `37` KB of it the brief copy. `report` is everything before the START
 * marker (what `gh pr create` actually receives); `brief` is the marked
 * content, verbatim, posted as its own PR comment after the body-hash
 * marker. A body with no START marker (a brief with no `## Reference`
 * section at all, or a non-brief-shaped body) splits to `{ report: body,
 * brief: null }` — nothing to post, nothing lost.
 *
 * Uses the LAST START marker and the FIRST END marker after it, never the
 * first START in the body: the template's own Decisions/Reference prose can
 * legitimately mention the marker syntax by name (as this very docstring
 * does), and the one real, intentional pair is always the final section in
 * a well-formed body — an `indexOf` from the front collided with exactly
 * such a mention live on this task's own dispatch (#397, PR `#398`),
 * truncating the report and posting a near-empty brief comment.
 */
const BRIEF_START = '<!-- aeg:brief:start -->'
const BRIEF_END = '<!-- aeg:brief:end -->'

function splitBriefSection(body: string): { report: string; brief: string | null } {
  const startIdx = body.lastIndexOf(BRIEF_START)
  if (startIdx === -1) return { report: body, brief: null }
  const contentStart = startIdx + BRIEF_START.length
  const endIdx = body.indexOf(BRIEF_END, contentStart)
  if (endIdx === -1) return { report: body, brief: null }
  return {
    report: body.slice(0, startIdx).trimEnd(),
    brief: body.slice(contentStart, endIdx).trim()
  }
}

/**
 * Posts the split-out brief as its own PR comment, marked `<!-- aeg:brief
 * -->` so every reader that binds to a frozen marker (exactly like the
 * `aeg:body-hash` marker above) recognizes it regardless of which identity
 * posted it. Posted AFTER the body-hash marker (task 4's own ordering) —
 * the marker freezes the report body first; the brief comment is reference
 * material, not a gate-read field.
 *
 * A failed post is a HARD refusal, same reasoning as `postBodyHashMarker`:
 * silently dropping the brief loses the PR's only durable record of intent,
 * indistinguishable from a Developer who never pasted one.
 */
function postBriefComment(url: string, brief: string): void {
  const match = /\/pull\/(\d+)/.exec(url)
  if (!match) {
    refuse([
      makeCheckError(
        'pr-body-frozen',
        `PR was created (${url || '(gh printed no URL)'}) but its number could not be parsed from the URL, so the aeg:brief comment was not posted.`,
        'Manually post the dispatched brief as a PR comment, prefixed with `<!-- aeg:brief -->` on its own line.'
      )
    ])
  }
  const prNumber = match[1] as string
  const commentBody = `<!-- aeg:brief -->\n${brief}\n`
  const tmp = join(tmpdir(), `vinaya-pr-create-brief-${process.pid}-${Date.now()}.md`)
  writeFileSync(tmp, commentBody)
  try {
    execFileSync('gh', ['pr', 'comment', prNumber, '--body-file', tmp], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    refuse([
      makeCheckError(
        'pr-body-frozen',
        `PR ${url} was created but posting its aeg:brief comment failed: ${err instanceof Error ? err.message : String(err)}`,
        `Post the comment manually: \`gh pr comment ${prNumber} --body-file <brief.md>\` (prefixed with \`<!-- aeg:brief -->\`).`
      )
    ])
  } finally {
    rmSync(tmp, { force: true })
  }
}

// --- commands ----------------------------------------------------------------

/**
 * Every check CI will run against this body, run here first.
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
function refuseOnBareDigits(body: string, retryCommand: string): void {
  const { violations } = checkBareDigits(body)
  if (violations.length === 0) return
  refuse(
    violations.map((v) =>
      makeCheckError(
        'body-bare-digits',
        `body-bare-digits: bare digit outside a fenced block, line ${v.line}: ${v.text}`,
        `Backtick the digit, move it into a fenced block, or state it as a symbol, then re-run \`${retryCommand}\`.`
      )
    )
  )
}

/**
 * Runs every registry check whose entry declares `PR_BODY` over the exact
 * body about to be sent to the forge, with `PR_NUMBER` explicitly UNSET
 * (`pr create` runs before any PR exists — an ambient/stale `PR_NUMBER`
 * inherited from the caller's shell must never let a `requiresOpenPr` check
 * fetch a foreign PR's state instead of taking its own documented "no PR
 * yet" bypass). `localOnly: true` skips every `requiresOpenPr` check outright
 * for the same reason (`closes-n`, `test-plan`, `evidence-fresh`,
 * `body-bare-digits`, `token-report` all take that bypass on their own body-
 * only path when actually run, but skipping them here is cheaper and matches
 * the pre-commit/pre-push hooks' own `--local` posture). The same set CI's
 * `vinaya-checks.yml` runs against the live body — so a body that opens
 * through this command is a body that passes there too.
 *
 * Skipped entirely when `rings.ring1_forgeWriteInterception` is `true` —
 * the same accelerator `resolveSections` already honors to skip
 * `validateForgeWrite`'s config-driven sections. That flag's whole point is
 * "skip brief-schema validation entirely"; running this registry-check pass
 * unconditionally underneath it would silently reintroduce exactly the
 * validation the accelerator was set to remove.
 */
async function refuseOnRedBody(body: string, branch: string, retryCommand: string): Promise<void> {
  const config = loadConfigChecked()
  if (config.ok && config.config?.rings?.ring1_forgeWriteInterception === true) return

  const specs = coreCheckRegistry().filter((s) => s.env && Object.hasOwn(s.env, 'PR_BODY'))
  const callerEnv: NodeJS.ProcessEnv = { ...process.env, PR_BODY: body, BRANCH: branch }
  delete callerEnv.PR_NUMBER

  const outcomes = await runChecks(specs, {
    parallel: defaultParallelism(),
    diffOnly: false,
    changedFiles: null,
    defaultTimeoutMs: 30_000,
    callerEnv,
    localOnly: true
  })

  const errors = outcomes.filter((o) => o.status === 'fail' || o.status === 'error').flatMap((o) => o.errors)
  if (errors.length === 0) return
  refuse(
    errors.map((e) =>
      makeCheckError(e.check, e.message, `${e.agent_recovery_prompt} Fix the body, then re-run \`${retryCommand}\`.`)
    )
  )
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

  // Split the brief out (task 4, #397) BEFORE any check runs: every gate
  // below — `validateForgeWrite`, `body-bare-digits`, the registry's
  // `PR_BODY` checks — grades what actually reaches the forge as the body,
  // never the reference brief riding along beside it. `body` from here on
  // IS the report half; `brief` (possibly null) is posted as its own
  // comment once the PR exists.
  const { report: body, brief } = splitBriefSection(rawBody)

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

  const errors = validateForgeWrite({
    body,
    title,
    sections,
    changedFiles,
    retryCommand: RETRY_CREATE,
    branch
  })
  if (errors.length > 0) refuse(errors)
  refuseOnBareDigits(body, RETRY_CREATE)
  await refuseOnRedBody(body, branch, RETRY_CREATE)

  if (validateOnly) {
    reportPass(json, 'pr create')
    return
  }
  // `resolveShippableArgs` materializes whatever `body` this BodyResult
  // carries into the temp file `gh` actually reads — swapping in the report
  // half here (never the raw combined body) is what makes `body` the file
  // `gh pr create` receives, not merely the text these checks graded.
  const shippedBodyResult: BodyResult | null = bodyResult ? { ...bodyResult, body } : null
  const url = runGhWrite(['pr', 'create'], ghArgs, shippedBodyResult, json)
  postBodyHashMarker(url, body)
  if (brief !== null) postBriefComment(url, brief)
}

export function prEditCommand(args: string[]): void {
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

  const errors = validateForgeWrite({
    body: body ?? '',
    title,
    sections: body === null ? [] : sections,
    changedFiles,
    retryCommand: RETRY_EDIT,
    branch
  })
  if (errors.length > 0) refuse(errors)
  if (body !== null) refuseOnBareDigits(body, RETRY_EDIT)

  if (validateOnly) {
    reportPass(json, 'pr edit')
    return
  }
  runGhWrite(['pr', 'edit', prRef], ghArgs, bodyResult, json)
}
