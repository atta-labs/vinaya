/**
 * dispatchTask — renders the brief from the Issue and the tree
 * (`assembleAndRenderBrief`, `lib/brief-assembly.ts`),
 * posts it once as the frozen `aeg:brief:v1` Issue comment, and starts the
 * Developer through `dispatchRole` when that function is available, else
 * prints the brief and the manual dispatch instruction.
 *
 * The brief is frozen by design: this function refuses a second post on the
 * same Issue rather than ever overwriting or appending a `v2` — a changed
 * brief is a changed Issue, re-dispatched only by a later escalation path
 * this task does not build (see `taskDispatchCommand`'s own doc comment).
 *
 * Order matters: the brief is rendered FIRST, before the existing-comment
 * check even runs — a render that refuses posts nothing and never touches
 * the forge to look for a prior dispatch. Cheaper checks are not run first;
 * the render is the one check every other step depends on being real.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AEG_BRIEF_V1_MARKER, isPrincipal } from '@attalabs/aeg-core'
import { assembleAndRenderBrief } from './brief-assembly.js'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from './config.js'
import { currentGhLogin, postMarkedComment } from './forge-write.js'

export { AEG_BRIEF_V1_MARKER, contentAfterTwoLines } from '@attalabs/aeg-core'

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

export type DispatchTaskInput = { tranche: string; n: number; agent?: DispatchAgent }
export type DispatchTaskResult = { posted: boolean; commentUrl: string | null; brief: string }

/** Thrown for every refusal — the CLI shim (`taskDispatchCommand`) lets it
 * propagate to `index.ts`'s own top-level catch, which prints and exits 1;
 * a direct caller (a test, `runTask` later) catches it like any `Error`. */
export class DispatchTaskError extends Error {}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

type IssueComment = { body: string; url: string }
type IssueCommentsJson = { comments: IssueComment[] }

/**
 * `sha256` of the brief text as it will appear below the two header lines
 * once posted — `postMarkedComment` appends its own trailing `\n`, so the
 * hashed content is `brief + '\n'`, exactly what `contentAfterTwoLines`
 * reconstructs from the live posted comment. Computing the hash any other
 * way (e.g. over `brief` alone) would make the writer and every reader
 * disagree on a real, once-posted comment.
 */
export function briefHash(brief: string): string {
  return createHash('sha256').update(`${brief}\n`).digest('hex')
}

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
    return (JSON.parse(out) as IssueCommentsJson).comments
  } catch {
    throw new DispatchTaskError(`could not parse \`gh issue view ${n} --json comments\` output.`)
  }
}

/** The comment's first line is the whole check — a marker-shaped string
 * anywhere else in a comment's body (including the newly-rendered brief's
 * own text, which this function never scans) is never mistaken for a real
 * prior dispatch. */
function findExistingV1Comment(n: number): IssueComment | null {
  return fetchIssueComments(n).find((c) => c.body.split('\n')[0] === AEG_BRIEF_V1_MARKER) ?? null
}

/**
 * Mirrors `dispatch.ts`'s real `DispatchOpts` — `promptFile` is REQUIRED
 * there, not optional: found live reviewing this
 * exact task, the first-cut type here omitted it entirely, a mismatch `tsc`
 * cannot catch across a dynamic import resolved by a runtime-built
 * specifier (see `resolveDispatchRole` below). `promptFile` is unused by
 * any vendor's invocation today per that file's own doc comment, but the
 * field is still required by the type this dynamically-loaded function
 * actually exports, so a real value is always supplied — see
 * `withPromptFile`.
 */
type DispatchRoleOpts = { task: number; promptFile: string }
type DispatchRoleFn = (role: string, agent: DispatchAgent, prompt: string, opts: DispatchRoleOpts) => Promise<unknown>

/**
 * `apps/cli/src/lib/dispatch.ts`'s `dispatchRole` export is a soft
 * dependency: it may not exist yet, or may exist without this export. A
 * dynamic import that fails to resolve is caught and treated as "not
 * available", never as a hard error — the whole point of the soft edge.
 *
 * The specifier is built at runtime, not written as a string literal
 * `import()` argument: a literal specifier is statically resolved by
 * `tsc`, which fails the whole build while `dispatch.ts` does not yet
 * exist. A variable specifier is opaque to that static resolution, exactly
 * as this soft dependency needs.
 */
async function resolveDispatchRole(): Promise<DispatchRoleFn | null> {
  const dispatchModulePath = './dispatch.js'
  try {
    const mod = (await import(dispatchModulePath)) as { dispatchRole?: unknown }
    return typeof mod.dispatchRole === 'function' ? (mod.dispatchRole as DispatchRoleFn) : null
  } catch {
    return null
  }
}

function printManualDispatchInstruction(tranche: string, n: number, agent: DispatchAgent): void {
  process.stdout.write(
    '\nvinaya task dispatch: `dispatchRole` is not available yet (apps/cli/src/lib/dispatch.ts has no such export) — the brief above is posted; start the developer yourself:\n\n' +
      `  vinaya dispatch developer --agent ${agent} --tranche ${tranche} --task ${n}\n\n` +
      'Once `dispatchRole` ships, the same `--agent` flag on `task dispatch` will start it automatically.\n'
  )
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
 * Injection seam for `apps/cli/tests/lib/dispatch-task.test.ts` — same
 * convention `commands/archive.ts`'s `ArchiveDeps` already uses in this
 * repo. `taskDispatchCommand` (the one real caller) never passes a second
 * argument, so `dispatchTask({ tranche, n, agent })` is the whole call site
 * the surface-index rule sees; a test substitutes fakes here instead of
 * hitting a real forge or mocking a module.
 */
export type DispatchTaskDeps = {
  assembleAndRenderBrief: typeof assembleAndRenderBrief
  findExistingV1Comment: (n: number) => IssueComment | null
  postMarkedComment: typeof postMarkedComment
  resolveDispatchRole: () => Promise<DispatchRoleFn | null>
  resolveDispatchAuthorization: () => DispatchAuthorization
}

const defaultDeps: DispatchTaskDeps = {
  assembleAndRenderBrief,
  findExistingV1Comment,
  postMarkedComment,
  resolveDispatchRole,
  resolveDispatchAuthorization
}

/**
 * Renders the brief, posts it as the frozen `aeg:brief:v1` Issue comment
 * (refusing a second one), and starts the Developer when `--agent` is given
 * and `dispatchRole` is available. Dispatching at all — posting the brief,
 * with or without `--agent` — is Principal-only; see
 * `resolveDispatchAuthorization`'s own doc comment.
 */
export async function dispatchTask(
  input: DispatchTaskInput,
  deps: DispatchTaskDeps = defaultDeps
): Promise<DispatchTaskResult> {
  const { tranche, n, agent } = input

  // Authorization is checked before anything else — no render, no forge
  // read, no post — for the whole command, not only the `--agent` path.
  {
    const { authorized, login } = deps.resolveDispatchAuthorization()
    if (!authorized) {
      throw new DispatchTaskError(
        login === null
          ? 'could not resolve the identity `gh` is authenticated as — `task dispatch` is Principal-only and refuses rather than proceeding with an unverified actor.'
          : `\`${login}\` is not on the Principal allowlist — \`task dispatch\` is Principal-only.`
      )
    }
  }

  const result = await deps.assembleAndRenderBrief(tranche, String(n))
  if (!result.ok) {
    throw new DispatchTaskError(
      `cannot dispatch — brief render refused:\n${result.missing.map((m) => `  - ${m}`).join('\n')}`
    )
  }

  const existing = deps.findExistingV1Comment(n)
  if (existing) {
    throw new DispatchTaskError(`Task ${n} in tranche \`${tranche}\` is already dispatched — see ${existing.url}`)
  }

  const hash = briefHash(result.brief)
  const commentBody = `Brief hash: ${hash}\n${result.brief}`
  const url = deps.postMarkedComment('issue', String(n), AEG_BRIEF_V1_MARKER, commentBody)

  if (agent) {
    const dispatchRole = await deps.resolveDispatchRole()
    if (dispatchRole) {
      await withPromptFile(result.brief, (promptFile) =>
        dispatchRole('developer', agent, result.brief, { task: n, promptFile })
      )
    } else {
      printManualDispatchInstruction(tranche, n, agent)
    }
  }

  return { posted: true, commentUrl: url, brief: result.brief }
}
