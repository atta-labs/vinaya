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
import { assembleAndRenderBrief } from './brief-assembly.js'
import { postMarkedComment } from './forge-write.js'

export const AEG_BRIEF_V1_MARKER = '<!-- aeg:brief:v1 -->'

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
 * The content a reader recomputes the brief hash over: everything in the
 * posted comment after the marker line and the `Brief hash:` line, as a raw
 * substring — never a line-split-then-rejoin, which would silently
 * normalize whatever separates the two header lines from the brief
 * differently than the literal bytes a reader sees below them.
 *
 * Duplicated (not imported) in `verify-dispatch.ts` and
 * `check-brief-shape.ts` — both live outside this file's own reach
 * (`@attalabs/aeg-core`'s `bin/`, and `apps/cli/src/checks/`, cannot import
 * `apps/cli/src/lib/dispatch-task.ts` without an awkward or backwards
 * dependency) — same discipline this file's own `sh()` mirrors from
 * `pr.ts`'s local `git()`. All three copies share this one doc comment's
 * contract; a change to the hashed region updates every copy.
 */
export function contentAfterTwoLines(body: string): string {
  const first = body.indexOf('\n')
  if (first === -1) return ''
  const second = body.indexOf('\n', first + 1)
  if (second === -1) return ''
  return body.slice(second + 1)
}

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

type DispatchRoleFn = (role: string, agent: DispatchAgent, brief: string, context: { task: number }) => Promise<unknown>

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
}

const defaultDeps: DispatchTaskDeps = {
  assembleAndRenderBrief,
  findExistingV1Comment,
  postMarkedComment,
  resolveDispatchRole
}

/**
 * Renders the brief, posts it as the frozen `aeg:brief:v1` Issue comment
 * (refusing a second one), and starts the Developer when `--agent` is given
 * and `dispatchRole` is available.
 */
export async function dispatchTask(
  input: DispatchTaskInput,
  deps: DispatchTaskDeps = defaultDeps
): Promise<DispatchTaskResult> {
  const { tranche, n, agent } = input

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
      await dispatchRole('developer', agent, result.brief, { task: n })
    } else {
      printManualDispatchInstruction(tranche, n, agent)
    }
  }

  return { posted: true, commentUrl: url, brief: result.brief }
}
