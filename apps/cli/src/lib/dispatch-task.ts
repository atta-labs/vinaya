/**
 * `prepareTask` — renders the brief from the Issue and the tree
 * (`assembleAndRenderBrief`, `lib/brief-assembly.ts`), refuses on any gap,
 * and posts it as a frozen `aeg:brief:v<k>` Issue comment. Starts no agent —
 * see its own doc comment.
 *
 * `dispatchTask` composes `prepareTask` with the existing developer-start
 * half: with `--agent` given, it starts the Developer through `dispatchRole`
 * (`./dispatch.js`, a static import — there is no fallback path; a build
 * that cannot reach `dispatchRole` fails to compile). `@deprecated` in favor
 * of `task brief` (`prepareTask` alone) and `task run` (the future
 * unattended loop).
 *
 * The frozen comment is never edited or deleted (task 4, Issue
 * #483, O3): a plain call refuses a second post on the same Issue, naming
 * the existing frozen brief; `--supersede` is the one sanctioned way to
 * correct a wrong one — it APPENDS a new, higher-versioned comment naming
 * its predecessor and a reason, never touching the original. Every reader of
 * "the frozen brief" resolves the newest version (`@attalabs/aeg-core`'s
 * `resolveNewestFrozenBrief`) — `dispatchTask` (below) and the review loop
 * (`dev-review-loop.ts`'s `fetchFrozenBrief`) share the same resolver.
 *
 * Order matters: the brief is rendered FIRST, before the existing-comment
 * check even runs — a render that refuses posts nothing and never touches
 * the forge to look for a prior dispatch. Cheaper checks are not run first;
 * the render is the one check every other step depends on being real.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AEG_BRIEF_V1_MARKER,
  briefHash,
  briefMarkerFor,
  isPrincipal,
  parseRationaleFields,
  resolveNewestFrozenBrief
} from '@attalabs/aeg-core'
import { dispatchRole, isAgentClass, resolveClassModel, type AgentClass } from './dispatch.js'
import { assembleAndRenderBrief, assembleAndRenderBriefForIssue } from './brief-assembly.js'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from './config.js'
import { currentGhLogin, postMarkedComment } from './forge-write.js'

export { AEG_BRIEF_V1_MARKER, briefHash, contentAfterTwoLines } from '@attalabs/aeg-core'

/**
 * The coding-agent vendor `--agent` names — distinct from `agent-vendors.ts`'s
 * `AgentVendor` (which vendor's install-time artifact format `vinaya init`
 * scaffolds: `.claude/commands/`, `.gemini/commands/`, `.agents/skills/`).
 * That type has no `codex` member and its `skills` member is meaningless
 * here — dispatch targets a coding-agent CLI session, not an install
 * artifact format, so this is a deliberately separate, same-shaped type
 * rather than a reuse that would silently accept `--agent skills`.
 */
export const DISPATCH_AGENTS = ['claude', 'codex', 'gemini'] as const
export type DispatchAgent = (typeof DISPATCH_AGENTS)[number]

export type DispatchTaskInput = { tranche: string; n: number; agent?: DispatchAgent; model?: string }
export type DispatchTaskResult = { posted: boolean; commentUrl: string | null; brief: string }

/** Thrown for every refusal — the CLI shim (`taskDispatchCommand`) lets it
 * propagate to `index.ts`'s own top-level catch, which prints and exits 1;
 * a direct caller (a test, `runTask` later) catches it like any `Error`. */
export class DispatchTaskError extends Error {}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

type IssueComment = { body: string; url: string; author: string | null }
type IssueCommentsJson = { comments: Array<{ body: string; url: string; author?: { login?: string } | null }> }

function fetchIssueComments(n: number): IssueComment[] {
  let out: string
  try {
    out = sh('gh', ['issue', 'view', String(n), '--json', 'comments'])
  } catch (err) {
    throw new DispatchTaskError(
      `could not fetch Issue #${n}'s comments (\`gh issue view\`) to check for an existing brief — refusing rather than risking a duplicate: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  try {
    return (JSON.parse(out) as IssueCommentsJson).comments.map((c) => ({
      body: c.body,
      url: c.url,
      author: c.author?.login ?? null
    }))
  } catch {
    throw new DispatchTaskError(`could not parse \`gh issue view ${n} --json comments\` output.`)
  }
}

/** Same allowlist machinery every principal-authored-comment reader in this codebase shares (`dev-review-loop.ts`'s identical `principalAllowlist`). */
function principalAllowlist(): string[] {
  return resolvePrincipalAllowlist(loadTrustAnchorConfig())
}

function fetchIssueBody(n: number): string {
  try {
    return JSON.parse(sh('gh', ['issue', 'view', String(n), '--json', 'body'])).body as string
  } catch (err) {
    throw new DispatchTaskError(
      `could not fetch Issue #${n}'s body (\`gh issue view\`) to resolve its suggested agent-class: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Pulls the leading `high`/`mid`/`fast` word out of the Issue's own
 * "Suggested agent-class" rationale field (`**Suggested agent-class** —
 * mid — <reason>`, `aeg-root/roles/planner.md`) — `parseRationaleFields`
 * (`@attalabs/aeg-core`) returns the whole labeled field, label included, so
 * this strips the label and keeps only the class word. `null` when the
 * field is absent, unparseable, or names a word outside the three-value
 * vocabulary — never a guess.
 */
export function extractAgentClass(rawRationaleField: string): AgentClass | null {
  const m = /agent-class\**\s*[—–-]\s*(\w+)/i.exec(rawRationaleField)
  const word = m?.[1]?.toLowerCase()
  return word !== undefined && isAgentClass(word) ? word : null
}

/**
 * O3 — the pure resolution core, exported so it is directly testable with no
 * forge I/O (MAJOR 2, #456 round 1: every existing `dispatchTask` test fakes
 * this decision out entirely, so this real logic was never exercised). An
 * explicit `--model` always wins (never re-derived or overridden) — that
 * includes an "unacceptable" one: this function never refuses or sanitizes a
 * model by its shape, it only decides which value reaches `dispatchRole`;
 * the actual by-name refusal is `dispatchRole`'s own job (`dispatch.ts`'s
 * `identifyVendorFromModelShape`, O4), so an explicit value is passed through
 * completely unchanged, wrong-vendor-shaped or not, rather than laundered
 * into something that would slip past that check. Absent an explicit model,
 * `rawRationaleField` (the Issue's own already-fetched "Suggested
 * agent-class" text, or `undefined` when it couldn't be fetched/doesn't
 * exist) is parsed for its class and resolved through this vendor's own
 * class-to-model table (`resolveClassModel`). `undefined` when no explicit
 * model was given AND either the class can't be read or this vendor has no
 * verified mapping for it — `dispatchRole` then omits `--model` entirely,
 * the same as today, rather than inventing a value.
 */
export function resolveModelFromRationale(
  agent: DispatchAgent,
  rawRationaleField: string | undefined,
  explicitModel: string | undefined
): string | undefined {
  if (explicitModel !== undefined) return explicitModel
  const agentClass = rawRationaleField !== undefined ? extractAgentClass(rawRationaleField) : null
  if (agentClass === null) return undefined
  return resolveClassModel(agent, agentClass) ?? undefined
}

/**
 * The forge-reading wrapper around `resolveModelFromRationale` — fetches
 * this task's own Issue body only when an explicit model wasn't already
 * given (the same short-circuit `resolveModelFromRationale` itself performs,
 * kept here too so a `--model`-naming caller never pays for a `gh issue
 * view` call it doesn't need).
 */
function resolveModelForDispatch(
  agent: DispatchAgent,
  issue: number,
  explicitModel: string | undefined
): string | undefined {
  if (explicitModel !== undefined) return explicitModel
  const raw = parseRationaleFields(fetchIssueBody(issue)).suggestedAgentClass
  return resolveModelFromRationale(agent, raw, undefined)
}

/**
 * The NEWEST principal-authored frozen-brief comment on Issue `n`, or
 * `null` — `@attalabs/aeg-core`'s `resolveNewestFrozenBrief` (task 4,
 * Issue #483, O3), never a v1-only scan: a supersession is an
 * APPENDED comment, so the guard below (and `--supersede`'s own predecessor
 * lookup) must see the highest version posted, not the first.
 */
function findExistingFrozenBrief(n: number): (IssueComment & { version: number }) | null {
  return resolveNewestFrozenBrief(fetchIssueComments(n), principalAllowlist())
}

/**
 * Writes `prompt` to a fresh temp file and calls `fn` with its path,
 * removing the file (and its directory) afterward regardless of outcome —
 * `dispatchRole`'s real `DispatchOpts.promptFile` is required even though
 * every vendor's own invocation reads the prompt from `prompt`/stdin, not
 * this file, today.
 */
async function withPromptFile<T>(prompt: string, fn: (promptFile: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-dispatch-prompt-'))
  const promptFile = join(dir, 'prompt.md')
  writeFileSync(promptFile, prompt, 'utf8')
  try {
    return await fn(promptFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export type DispatchAuthorization = { authorized: boolean; login: string | null }

/**
 * `process.md`'s own Phase 5 ("Who: Principal, or delegated Brief Author
 * within ratification-window scope") names dispatch itself as a Principal
 * action, not only the `--agent` session-start it can optionally trigger —
 * freezing a brief onto an Issue is the "todo → in-flight" transition, and
 * every automated dispatch already runs under the Principal's own `gh`
 * identity (the same posture every other write in this model takes), so
 * gating the whole command costs no real automation path. Found live
 * (security review, round `1`): the first cut gated only `--agent`, leaving
 * plain posting open to any actor with `gh` write access — precisely the
 * gap this task's own by-hand recovery on Issue `#427` exploited, posting
 * a comment `dispatchTask` never authorized. Checked BEFORE anything
 * else — no render, no forge read, no post — mirroring
 * `refuseUnlessPrincipal`'s own fail-closed posture (`lib/forge-write.ts`,
 * `pr rule`/`issue objectives edit`): an unresolvable identity refuses the
 * same as a disallowed one.
 */
function resolveDispatchAuthorization(): DispatchAuthorization {
  const login = currentGhLogin()
  const allowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())
  return { authorized: login !== null && isPrincipal(login, allowlist), login }
}

/**
 * Shared by `prepareTask` and `prepareIssueTask` — a `--supersede` reason
 * must be non-empty and single-line regardless of which path is preparing
 * the task, same authorization/corruption reasoning either way.
 *
 * Security review, PR #503 round 2, MEDIUM: the reason is spliced into a
 * SINGLE header line (`Supersedes: <url> — <reason>`) that every reader
 * (`frozenBriefContent`/`contentAfterNLines`) counts as exactly one of the
 * fixed three header lines for a v2+ comment. A `\n`/`\r` in the reason
 * would shift that count, corrupting `.content` for every reader of the
 * superseding version with no error surfaced anywhere.
 */
function validateSupersede(supersede: { reason: string } | undefined): void {
  if (!supersede) return
  if (supersede.reason.trim().length === 0) {
    throw new DispatchTaskError(
      '--supersede requires --reason <text> — a superseding brief must name why the prior one was wrong, same authorization as a first freeze, never a silent rewrite.'
    )
  }
  if (/[\r\n]/.test(supersede.reason)) {
    throw new DispatchTaskError(
      "--reason must be a single line — it becomes one line of the frozen comment header, and a newline in it would corrupt every reader's header-line count for this version."
    )
  }
}

export type PrepareTaskInput = {
  tranche: string
  n: number
  /**
   * `vinaya task brief <tranche> <n> --supersede --reason <text>`
   * (task 4, Issue #483, O3) — posts a new, higher-versioned
   * frozen brief naming its predecessor and this reason, instead of
   * refusing on the existing one. Absent, `prepareTask` keeps its original
   * behavior: refuse when any frozen brief already exists.
   */
  supersede?: { reason: string }
}
export type PrepareTaskResult = { issue: number; brief: string; commentUrl: string; version: number }

/**
 * Injection seam for `apps/cli/tests/lib/dispatch-task.test.ts`. `beforePost`
 * is an opaque hook, not an agent-shaped one — this type carries no
 * `DispatchAgent`, no model, nothing about starting a developer. `dispatchTask`
 * (O3) is the only caller that ever supplies it, closing over its own
 * `agent`/`model` to resolve and validate the model there; `prepareTask`
 * itself never learns what the hook does, which is what keeps it agent-free —
 * a preparation function that had to know about agents to keep `dispatchTask`
 * byte-identical would mean the seam belonged somewhere else entirely.
 */
export type PrepareTaskDeps = {
  assembleAndRenderBrief: typeof assembleAndRenderBrief
  findExistingFrozenBrief: (n: number) => (IssueComment & { version: number }) | null
  postMarkedComment: typeof postMarkedComment
  resolveDispatchAuthorization: () => DispatchAuthorization
  beforePost?: (issue: number) => void | Promise<void>
}

const defaultPrepareTaskDeps: PrepareTaskDeps = {
  assembleAndRenderBrief,
  findExistingFrozenBrief,
  postMarkedComment,
  resolveDispatchAuthorization
}

/**
 * O1 — the preparation half extracted from what used to be all of
 * `dispatchTask`: resolves the task's Issue, renders the brief, refuses on
 * any gap, and posts the brief as a frozen `aeg:brief:v<k>` Issue comment —
 * `v1` on a first post, or `predecessor.version + 1` under `--supersede`
 * (O3). Starts no agent under any circumstances — that is `dispatchTask`'s
 * job (O3, developer-start half), composed from this function plus the
 * existing developer-start half below.
 *
 * `beforePost`, when given, runs after the existing-brief guard passes but
 * before the comment is posted — `dispatchTask` uses this to resolve and
 * validate `--agent`'s model BEFORE the frozen post exists, preserving MAJOR
 * 1's ordering guarantee (#456 round 1: a bad model must never leave a
 * permanently-dispatched task) without this function itself needing to know
 * why the hook exists.
 */
export async function prepareTask(
  input: PrepareTaskInput,
  deps: PrepareTaskDeps = defaultPrepareTaskDeps
): Promise<PrepareTaskResult> {
  const { tranche, n, supersede } = input

  // Authorization is checked before anything else — no render, no forge
  // read, no post.
  {
    const { authorized, login } = deps.resolveDispatchAuthorization()
    if (!authorized) {
      throw new DispatchTaskError(
        login === null
          ? 'could not resolve the identity `gh` is authenticated as — preparing a task is Principal-only and refuses rather than proceeding with an unverified actor.'
          : `\`${login}\` is not on the Principal allowlist — preparing a task is Principal-only.`
      )
    }
  }

  validateSupersede(supersede)

  const result = await deps.assembleAndRenderBrief(tranche, String(n))
  if (!result.ok) {
    throw new DispatchTaskError(
      `cannot dispatch — brief render refused:\n${result.missing.map((m) => `  - ${m}`).join('\n')}`
    )
  }

  // `result.issue` is the real forge Issue number the render step already
  // resolved from the task id — used for every forge read/write below,
  // never `n` (the task id) again. Reusing `n` as an Issue number here was
  // the live bug: dispatching task 3 posted its brief on Issue #3, an
  // unrelated merged Issue, because this code used to read `n` here.
  const issue = result.issue

  const existing = deps.findExistingFrozenBrief(issue)
  const hash = briefHash(result.brief)

  let marker: string
  let commentBody: string
  let version: number

  if (supersede) {
    if (!existing) {
      throw new DispatchTaskError(
        `Task ${n} in tranche \`${tranche}\` has no frozen brief yet — nothing to supersede. Run \`vinaya task brief ${tranche} ${n}\` without --supersede first.`
      )
    }
    // The original v1 (and every prior version) is never edited or deleted —
    // only appended past. `Supersedes:` names the predecessor's own comment
    // URL and the reason, so history stays and the mistake stops being
    // authoritative (Traps to avoid).
    version = existing.version + 1
    marker = briefMarkerFor(version)
    commentBody = `Brief hash: ${hash}\nSupersedes: ${existing.url} — ${supersede.reason}\n${result.brief}`
  } else {
    if (existing) {
      throw new DispatchTaskError(`Task ${n} in tranche \`${tranche}\` is already dispatched — see ${existing.url}`)
    }
    version = 1
    marker = AEG_BRIEF_V1_MARKER
    commentBody = `Brief hash: ${hash}\n${result.brief}`
  }

  if (deps.beforePost) {
    await deps.beforePost(issue)
  }

  const url = deps.postMarkedComment('issue', String(issue), marker, commentBody)

  return { issue, brief: result.brief, commentUrl: url, version }
}

export type PrepareIssueTaskInput = {
  issue: number
  /** Same meaning as `PrepareTaskInput.supersede` — see that field's doc comment. */
  supersede?: { reason: string }
}

/** Same shape as `PrepareTaskDeps`, over `assembleAndRenderBriefForIssue` instead of the tranche-keyed renderer. */
export type PrepareIssueTaskDeps = {
  assembleAndRenderBriefForIssue: typeof assembleAndRenderBriefForIssue
  findExistingFrozenBrief: (n: number) => (IssueComment & { version: number }) | null
  postMarkedComment: typeof postMarkedComment
  resolveDispatchAuthorization: () => DispatchAuthorization
  beforePost?: (issue: number) => void | Promise<void>
}

const defaultPrepareIssueTaskDeps: PrepareIssueTaskDeps = {
  assembleAndRenderBriefForIssue,
  findExistingFrozenBrief,
  postMarkedComment,
  resolveDispatchAuthorization
}

/**
 * `prepareTask`'s tranche-less twin (O1) — renders the
 * brief from a backlog Issue's own body (`assembleAndRenderBriefForIssue`)
 * and posts it as the same frozen `aeg:brief:v<k>` Issue comment, with the
 * same authorization, existing-brief and supersede rules. Starts no agent,
 * same as `prepareTask`.
 */
export async function prepareIssueTask(
  input: PrepareIssueTaskInput,
  deps: PrepareIssueTaskDeps = defaultPrepareIssueTaskDeps
): Promise<PrepareTaskResult> {
  const { issue: n, supersede } = input

  {
    const { authorized, login } = deps.resolveDispatchAuthorization()
    if (!authorized) {
      throw new DispatchTaskError(
        login === null
          ? 'could not resolve the identity `gh` is authenticated as — preparing a task is Principal-only and refuses rather than proceeding with an unverified actor.'
          : `\`${login}\` is not on the Principal allowlist — preparing a task is Principal-only.`
      )
    }
  }

  validateSupersede(supersede)

  const result = await deps.assembleAndRenderBriefForIssue(n)
  if (!result.ok) {
    throw new DispatchTaskError(
      `cannot dispatch — brief render refused:\n${result.missing.map((m) => `  - ${m}`).join('\n')}`
    )
  }
  const issue = result.issue

  const existing = deps.findExistingFrozenBrief(issue)
  const hash = briefHash(result.brief)

  let marker: string
  let commentBody: string
  let version: number

  if (supersede) {
    if (!existing) {
      throw new DispatchTaskError(
        `Issue #${n} has no frozen brief yet — nothing to supersede. Run \`vinaya task brief --issue ${n}\` without --supersede first.`
      )
    }
    version = existing.version + 1
    marker = briefMarkerFor(version)
    commentBody = `Brief hash: ${hash}\nSupersedes: ${existing.url} — ${supersede.reason}\n${result.brief}`
  } else {
    if (existing) {
      throw new DispatchTaskError(`Issue #${n} is already dispatched — see ${existing.url}`)
    }
    version = 1
    marker = AEG_BRIEF_V1_MARKER
    commentBody = `Brief hash: ${hash}\n${result.brief}`
  }

  if (deps.beforePost) {
    await deps.beforePost(issue)
  }

  const url = deps.postMarkedComment('issue', String(issue), marker, commentBody)

  return { issue, brief: result.brief, commentUrl: url, version }
}

export type PrepareTaskOrIssueInput =
  | ({ tranche: string; n: number } & Pick<PrepareTaskInput, 'supersede'>)
  | ({ issue: number } & Pick<PrepareIssueTaskInput, 'supersede'>)

/**
 * `taskBriefCommand`'s one named lib function (`apps/cli/specs/surface.md`'s
 * one-lib-call-per-command rule, O1) — `prepareTask` and
 * `prepareIssueTask` each stay a real, independently-testable function, but
 * the command that can dispatch either shape calls through this single
 * chokepoint rather than two named lib calls.
 */
export async function prepareTaskOrIssue(input: PrepareTaskOrIssueInput): Promise<PrepareTaskResult> {
  return 'tranche' in input
    ? prepareTask({ tranche: input.tranche, n: input.n, supersede: input.supersede })
    : prepareIssueTask({ issue: input.issue, supersede: input.supersede })
}

/**
 * Injection seam for `apps/cli/tests/lib/dispatch-task.test.ts` — same
 * convention `commands/archive.ts`'s `ArchiveDeps` already uses in this
 * repo. `taskDispatchCommand` (the one real caller) never passes a second
 * argument, so `dispatchTask({ tranche, n, agent })` is the whole call site
 * the surface-index rule sees; a test substitutes fakes here instead of
 * hitting a real forge or mocking a module.
 */
export type DispatchTaskDeps = {
  assembleAndRenderBrief: typeof assembleAndRenderBrief
  findExistingFrozenBrief: (n: number) => (IssueComment & { version: number }) | null
  postMarkedComment: typeof postMarkedComment
  dispatchRole: typeof dispatchRole
  resolveDispatchAuthorization: () => DispatchAuthorization
  resolveModelForDispatch: (
    agent: DispatchAgent,
    issue: number,
    explicitModel: string | undefined
  ) => string | undefined
}

const defaultDeps: DispatchTaskDeps = {
  assembleAndRenderBrief,
  findExistingFrozenBrief,
  postMarkedComment,
  dispatchRole,
  resolveDispatchAuthorization,
  resolveModelForDispatch
}

/**
 * O3 — `task dispatch`'s exact current behaviour,
 * rewritten as a thin composition of `prepareTask` (O1, above) plus the
 * existing developer-start half: renders and posts the frozen brief, then
 * starts the Developer through `dispatchRole` whenever `--agent` is given.
 * Dispatching at all — posting the brief, with or without `--agent` — is
 * Principal-only; see `resolveDispatchAuthorization`'s own doc comment.
 *
 * @deprecated in favor of `task brief` (preparation only) and `task run`
 * (preparation, then the full unattended loop) — kept for a documented
 * compatibility window while callers migrate.
 */
export async function dispatchTask(
  input: DispatchTaskInput,
  deps: DispatchTaskDeps = defaultDeps
): Promise<DispatchTaskResult> {
  const { tranche, n, agent, model } = input

  // MAJOR 1 (#456 round 1, related to #465, not fixed here): resolved and
  // validated BEFORE the brief is posted, not after, via `prepareTask`'s
  // `beforePost` hook — `resolveModelForDispatch` can throw (a `gh issue
  // view` failure fetching this task's own rationale) and if that happened
  // after the frozen comment existed, the "already dispatched" guard keys on
  // its mere existence with no flag to override it: the task would become
  // permanently undispatchable. Resolving inside the hook means a bad model
  // refuses with nothing yet written to the forge — the same guarantee the
  // un-extracted function used to provide directly.
  let resolvedModel: string | undefined

  const prep = await prepareTask(
    { tranche, n },
    {
      assembleAndRenderBrief: deps.assembleAndRenderBrief,
      findExistingFrozenBrief: deps.findExistingFrozenBrief,
      postMarkedComment: deps.postMarkedComment,
      resolveDispatchAuthorization: deps.resolveDispatchAuthorization,
      beforePost: agent
        ? async (issue) => {
            // O3: an explicit `--model` always wins; absent that, resolved
            // from this task's own Issue rationale against this vendor's
            // own class-to-model table — `undefined` either way falls
            // through to `dispatchRole`'s existing "no --model flag added"
            // behavior.
            resolvedModel = deps.resolveModelForDispatch(agent, issue, model)
          }
        : undefined
    }
  )

  if (agent) {
    // O5, Issue #456: `prep.issue`, never `n` — `dispatchRole`'s own `task`
    // opt is the resolved forge Issue number end to end (`VINAYA_TASK`
    // parses to `subject.issue`, `packages/aeg-core/src/log/envelope.ts`;
    // its resume-record key is `issue<n>`, `dispatch.ts`'s own
    // `resumeRecordPathFor`) — the same live-bug shape the comment above
    // already fixed for posting now applies here too: two tranches'
    // task-N runs on different Issues must never share one record.
    await withPromptFile(prep.brief, (promptFile) =>
      deps.dispatchRole('developer', agent, prep.brief, {
        task: prep.issue,
        promptFile,
        model: resolvedModel
      })
    )
  }

  return { posted: true, commentUrl: prep.commentUrl, brief: prep.brief }
}
