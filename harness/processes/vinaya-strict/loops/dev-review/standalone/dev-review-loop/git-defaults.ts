import { sh } from './gate-reading.js'
import { execFileSync } from 'node:child_process'
import { resolveMergeBase } from '../../../../tools/pr-report/pr-report-engine.js'
import type { SecurityScanRun } from './reviewer-dispatch.js'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WORKER_ENV_ALLOWLIST_KEYS } from '../../../../../../kernel/isolation/worker-boundary.js'
import { rmSync } from 'node:fs'
import type { IssueSurface } from '../../../../tools/task-contract/issue-validation'
import { parseIssueSurface } from '../../../../tools/task-contract/issue-validation'
import { patchIdAt } from '../../../../../../kernel/connectors/git/patch-id.js'
import { z } from 'zod'
import { DevReviewLoopEventSchema } from '../../../../../../kernel/log/schema'
import type { DevReviewLoopEventInput } from '../../../../tools/dev-review-policy/types'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { firstErrorLine } from '../../actions/live-developer-context.js'
import { readFileSync } from 'node:fs'

export function defaultRepoRoot(): string {
  return sh('git', ['rev-parse', '--show-toplevel'])
}

export function defaultGitRevParseOriginMain(): string {
  return sh('git', ['rev-parse', 'origin/main'])
}

export function defaultGitIsAncestor(ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: ['ignore', 'ignore', 'ignore']
    })
    return true
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'status' in err && err.status === 1) return false
    throw err
  }
}

export function defaultGitMergeBase(head: string): Promise<string> {
  return resolveMergeBase(head)
}

export function defaultGitFetch(sha: string): void {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', sha], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    // Non-fatal — the object may already be local; the diff below is the real test.
  }
}

export function defaultGitDiffShortstat(base: string, head: string): string {
  try {
    return sh('git', ['diff', `${base}...${head}`, '--shortstat'])
  } catch {
    return ''
  }
}

/**
 * O2: the direct `git diff --unified=0` between the previous round's head and
 * the current head — a two-endpoint diff (`from to`, not `from...head`), the
 * net content difference between the two heads themselves, which is what
 * "the changed lines between the two round heads" means (Traps to avoid).
 * `null` on any git failure, so the caller leaves the unchanged-line rule
 * inactive rather than treating an unreadable diff as "nothing changed."
 */
export function defaultGitUnifiedDiff(from: string, to: string): string | null {
  try {
    return execFileSync('git', ['diff', '--unified=0', from, to], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
  } catch {
    return null
  }
}

// --- the agent-configuration security scan -----------

/** The scanner subprocess's wall-time ceiling — a stuck scanner is reported `failed` (a timeout), never a pause the loop waits on. */
export const SECURITY_SCAN_TIMEOUT_MS = 120_000

/** The scanner subprocess's output-buffer cap, so a runaway scanner can never flood the driver's memory (the prompt itself is capped separately, tighter, by `capSecurityScanOutput`). */
export const SECURITY_SCAN_MAX_BUFFER_BYTES = 8 * 1024 * 1024

/** The pull request's changed paths, `git diff --name-only <base>...<head>` (the PR's own diff against its merge base). `[]` on any git failure — the scan is then `not_applicable` rather than run against paths that could not be read. */
export function defaultGitChangedPaths(base: string, head: string): readonly string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

/** `execFileSync`'s captured stream, as a string — a `Buffer` (the default) or an already-decoded string. */
export function scanStreamToString(stream: Buffer | string | null | undefined): string {
  if (stream === null || stream === undefined) return ''
  return typeof stream === 'string' ? stream : stream.toString('utf8')
}

/**
 * Runs the configured scanner as a repository subprocess over `cwd` (the
 * head-verified candidate copy, appended as the final argument), with:
 *   - a CONSTRUCTED environment carrying only `WORKER_ENV_ALLOWLIST_KEYS` —
 *     the same baseline `checks/runner.ts`'s `buildCheckEnv` gives every check
 *     (`harness/kernel/isolation/isolation.md` §2), so NO forge credential
 *     (`GH_TOKEN`/`GITHUB_TOKEN`) ever reaches a scanner running
 *     pull-request-authored configuration;
 *   - the pinned command the config names (`npx --yes <pkg>@<version> scan`),
 *     spawned via `execFile`, never a shell — the argv is the config's list
 *     plus the directory, so no shell interpretation of any element;
 *   - a time limit and an output-buffer cap.
 *
 * A completed run's exit code is deliberately NOT read as a verdict (Traps to
 * avoid: the scanner's exit codes are not proven live, so they are never relied
 * on) — whatever it printed IS the scan result the security pass reads, passed
 * through as `ok`. Only an inability to run to completion — the executable
 * missing, a timeout, or an output overflow — is `ok: false`, which the loop
 * reports to the reviewer and the Log as `failed` and continues past.
 */
export function defaultRunSecurityScanSubprocess(command: readonly string[], scanTargetDir: string): SecurityScanRun {
  const exe = command[0]
  if (exe === undefined) return { ok: false, reason: 'the configured securityScan.command is empty' }
  // Round-2 security review, HIGH: the scan target is a PULL-REQUEST-AUTHORED
  // checkout, so it must never steer the subprocess's own config resolution.
  // `npx --yes <pkg>@<ver>` reads `.npmrc` from the process cwd AND its
  // ancestors AND from `$HOME`; a pull request that committed an `.npmrc`
  // registry redirect at its repo root — or a real `$HOME/.npmrc` — would
  // otherwise make it fetch and run an ATTACKER package under the pinned name,
  // executing code on the driver host with the real `~/.ssh`/OAuth credentials
  // readable at `~`. Run instead from a FRESH, EMPTY sandbox directory used as
  // BOTH cwd and `HOME` (`WORKER_ENV_ALLOWLIST_KEYS` carries the real `HOME`,
  // overridden here): outside the repository, with no `.npmrc`, so the scan
  // target is only ever the directory passed as the final ARGUMENT, never the
  // cwd, and no PR-committed or user npm config is on any path the resolver
  // walks. This is the config-steering half; a full OS sandbox against a
  // trusted package reading an absolute credential path is the worker
  // boundary's own task (`harness/kernel/isolation/isolation.md` §§3–4), off on Linux.
  let sandbox: string
  try {
    sandbox = mkdtempSync(join(tmpdir(), 'vinaya-scan-'))
  } catch (err) {
    return { ok: false, reason: `could not create a scan sandbox: ${err instanceof Error ? err.message : String(err)}` }
  }
  const env: NodeJS.ProcessEnv = {}
  for (const key of WORKER_ENV_ALLOWLIST_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.HOME = sandbox
  try {
    const output = execFileSync(exe, [...command.slice(1), scanTargetDir], {
      cwd: sandbox,
      env,
      encoding: 'utf8',
      timeout: SECURITY_SCAN_TIMEOUT_MS,
      maxBuffer: SECURITY_SCAN_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { ok: true, output }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string
      stderr?: Buffer | string
      status?: number | null
      signal?: string | null
    }
    if (e.code === 'ENOENT') return { ok: false, reason: `scanner executable not found: ${exe}` }
    if (e.code === 'ENOBUFS' || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return { ok: false, reason: `scanner output exceeded ${SECURITY_SCAN_MAX_BUFFER_BYTES} bytes` }
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM')
      return { ok: false, reason: `scanner timed out after ${SECURITY_SCAN_TIMEOUT_MS}ms` }
    // A run that exited non-zero: its output is the scan result, passed through
    // (exit status not read as pass/fail). Only a run that printed nothing at
    // all is a genuine failure with no result to hand the reviewer.
    const combined = `${scanStreamToString(e.stdout)}${scanStreamToString(e.stderr)}`.trim()
    if (typeof e.status === 'number' && combined.length > 0) return { ok: true, output: combined }
    return { ok: false, reason: e.message }
  } finally {
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup — a leaked temp dir never fails the scan.
    }
  }
}

/**
 * O3: the task Issue's own `## Surface` `in:`/`out:` globs, read from
 * `gh issue view <task> --json body` and parsed by `parseIssueSurface` (the
 * same parser the Issue-authoring gate and the brief renderer use). `null`
 * when the Issue cannot be fetched or carries no parseable `## Surface`, so
 * the out-of-Surface rule stays inactive rather than treating every finding
 * as out of Surface.
 */
export function defaultResolveTaskSurface(task: number): IssueSurface | null {
  try {
    const out = sh('gh', ['issue', 'view', String(task), '--json', 'body'])
    const body = (JSON.parse(out) as { body?: string }).body ?? ''
    const parsed = parseIssueSurface(body)
    return parsed.ok ? parsed.value : null
  } catch {
    return null
  }
}

/** issue-711 O1 — this driver's base is always `main`, the same hardcoded base `gitRevParseOriginMain`/`defaultPullDefaultBranch` already use; never the PR's own `baseRefName` (the loop has no forge PR object to read one from). */
export function defaultPatchIdOf(sha: string): string | null {
  return patchIdAt('main', sha)
}

/**
 * O6: every event this loop emits, checked against its own
 * per-discriminant shape before `meta`/`subject` exist — derived from
 * `DevReviewLoopEventSchema` (`@attalabs/aeg-core`), the exact schema
 * `log-sink.ts` validates the FULL envelope against, minus the two fields
 * only `buildHeader` can fill in. Built once, from the schema the package
 * already exports — no second, hand-maintained field list to drift from
 * the real one.
 */
// `z.discriminatedUnion`'s own generic constrains every option's shape to be
// statically known to share ONE literal-typed discriminator key — a
// constraint TypeScript cannot verify across ten independently-omitted
// object schemas built by a `.map`, though every one of them genuinely
// does carry `event` as a string literal at runtime (the exact same
// `DevReviewLoopEventSchema` already relies on this to build itself). Cast
// through the function, not the data: a discriminated union gives a
// PER-BRANCH parse error (the failing field, not a "no branch matched"
// aggregate) — the entire reason this exists, so `z.union`'s looser typing
// is not an acceptable substitute here.
export const DevReviewLoopEventInputSchema: z.ZodTypeAny = (z.discriminatedUnion as any)(
  'event',
  DevReviewLoopEventSchema.options.map((option) =>
    (option as z.ZodObject<z.ZodRawShape>).omit({ meta: true, subject: true })
  )
)

/**
 * O6: refuses an event this loop is about to emit, naming the exact field
 * that fails its own schema — checked HERE, at emit time, inside
 * `logEvents` below, so a malformed event never reaches the outbox at all;
 * `log-flush.ts`'s own `parseOutboxLine` re-validation at flush time is
 * then a check that always passes for this loop's own lines, never the
 * first place a violation would be caught. Thrown, not warned:
 * `logEvents`'s every call site is inside the round loop's own top-level
 * `catch` (below), which turns any thrown error into a graceful
 * `pause{reason:'infrastructure'}` — the same treatment every other
 * unexpected failure on this path already gets, never a re-thrown
 * exception that crashes the process.
 */
export function assertValidLoopEvent(e: DevReviewLoopEventInput): void {
  const parsed = DevReviewLoopEventInputSchema.safeParse(e)
  if (parsed.success) return
  const issue = parsed.error.issues[0]
  const field = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)'
  throw new Error(
    `devReviewLoop: refusing to emit a "${e.event}" event — field \`${field}\` ${issue?.message ?? 'fails its own schema'}.`
  )
}

/** O7: the worktree's current branch, or `null` when unreadable (detached HEAD, or the worktree is gone). */
export function defaultReadWorktreeBranch(worktreePath: string): string | null {
  try {
    const name = sh('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']).trim()
    return name.length > 0 && name !== 'HEAD' ? name : null
  } catch {
    return null
  }
}

/** O7: every path the worktree changed since `base`, committed and uncommitted (`git diff --name-only <base>`). Best-effort: `[]` on any failure. */
export function defaultGitWorktreeChangedPaths(worktreePath: string, base: string): string[] {
  try {
    const raw = execFileSync('git', ['-C', worktreePath, 'diff', '--name-only', base], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  } catch {
    return []
  }
}

export function defaultGitWorktreeUntrackedPaths(worktreePath: string): string[] {
  try {
    const raw = execFileSync('git', ['-C', worktreePath, 'ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

export function gitOk(worktreePath: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', worktreePath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
}

/** A default-branch commit a turn merged in, and the paths the turn rolled back to an older default-branch state. */
export type MergedDefaultCommit = { commit: string; regressedPaths: string[] }

/**
 * The exact default-branch commit a Developer turn merged into its worktree:
 * the in-progress merge's incoming commit (`MERGE_HEAD`), else the newest
 * merge parent in `sinceBase..HEAD` (nearest the head) that is a default-branch
 * commit. The commit is read from the merge itself, never from a local
 * default-branch ref by name.
 *
 * The one source of truth for "is a default-branch commit" is the remote: the
 * default branch's head S is read with `git ls-remote <remoteUrl> refs/heads/main`
 * (fetching that one ref when S's object is missing locally), and a parent P
 * qualifies only when `git merge-base --is-ancestor P S` holds. A commit that
 * merely descends from the default branch (a side branch cut from it) fails
 * that test, so its paths stay task changes, and a merge whose parent fails it
 * never moves the base. `null` when the turn merged none or S is unreadable.
 *
 * `remoteUrl` is built by the driver from the repository it resolved, never read
 * from the worktree's `origin`, which the Developer can repoint; the head is
 * read from outside any checkout so no worktree config can rewrite the URL, and
 * the fetched object is only used under the hash the remote reported.
 *
 * Measuring against an older default-branch commit would hide a file the turn
 * reset to that older state, so every path that differs from S and that the
 * default branch changed after the merged commit is reported as `regressedPaths`.
 */
export function defaultReadMergedDefaultCommit(
  worktreePath: string,
  sinceBase: string | null,
  remoteUrl: string | null
): MergedDefaultCommit | null {
  const head = defaultReadDefaultBranchTip(remoteUrl)
  if (!remoteUrl || head === null) return null
  if (!ensureDefaultTipObject(worktreePath, head, remoteUrl)) return null
  const lines = (args: string[]): string[] =>
    (gitOk(worktreePath, args) ?? '').split('\n').filter((l) => l.trim().length > 0)
  const vetted = (sha: string): MergedDefaultCommit | null => {
    if (gitOk(worktreePath, ['merge-base', '--is-ancestor', sha, head]) === null) return null
    const advanced = new Set(lines(['diff', '--name-only', sha, head]))
    return { commit: sha, regressedPaths: lines(['diff', '--name-only', head]).filter((path) => advanced.has(path)) }
  }
  const incoming = gitOk(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  const fromMergeHead = incoming ? vetted(incoming) : null
  if (fromMergeHead) return fromMergeHead
  const range = sinceBase ? [`^${sinceBase}`, 'HEAD'] : ['HEAD']
  const merges = gitOk(worktreePath, ['rev-list', '--topo-order', '--merges', '--parents', ...range])
  if (!merges) return null
  for (const line of merges.split('\n')) {
    const [, ...parents] = line.trim().split(/\s+/)
    for (const parent of parents.slice(1)) {
      const found = vetted(parent)
      if (found) return found
    }
  }
  return null
}

/**
 * The default branch's head as the remote at `remoteUrl` reports it
 * (`git ls-remote <remoteUrl> refs/heads/main`, run from outside any checkout so
 * no worktree config can rewrite the URL). `null` when the URL is absent, the
 * call fails, or the answer is not a commit hash.
 */
export function defaultReadDefaultBranchTip(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null
  let remote: string
  try {
    remote = execFileSync('git', ['ls-remote', remoteUrl, 'refs/heads/main'], {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
  const head = remote.split(/\s+/)[0]
  return head && /^[0-9a-f]{40,64}$/.test(head) ? head : null
}

/**
 * Makes the default branch's `tip` commit present in the worktree's
 * repository, fetching the default branch from the driver-built `remoteUrl`
 * when it is missing — never through the worktree's own `origin`. The fetched
 * object is only used under the hash the remote reported. `false` when it
 * stays missing.
 */
export function ensureDefaultTipObject(worktreePath: string, tip: string, remoteUrl: string | null): boolean {
  if (gitOk(worktreePath, ['cat-file', '-e', `${tip}^{commit}`]) !== null) return true
  if (!remoteUrl) return false
  gitOk(worktreePath, ['fetch', '-q', remoteUrl, 'refs/heads/main'])
  return gitOk(worktreePath, ['cat-file', '-e', `${tip}^{commit}`]) !== null
}

/** How each changed path relates to the default branch's tip (`classifyAgainstDefaultTip`). */
export type DefaultTipClassification = { sameAsTip: string[]; mainDrift: string[]; taskChanged: string[] }

/** Each path's `<mode> <object>` at `commit`, absent when the commit has no such path; `null` when git cannot answer. */
export function treeEntriesAt(
  worktreePath: string,
  commit: string,
  paths: readonly string[]
): Map<string, string> | null {
  const out = gitOk(worktreePath, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', commit, '--', ...paths])
  if (out === null) return null
  const entries = new Map<string, string>()
  for (const record of out.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode, , object] = record.slice(0, tab).split(' ')
    entries.set(record.slice(tab + 1), `${mode} ${object}`)
  }
  return entries
}

/**
 * Sorts `paths` by their content at `head`, at the default branch's `tip`, and
 * at the merge base of the two: equal to the tip is `sameAsTip`; equal to the
 * merge base and not the tip is `mainDrift` (the default branch moved the path
 * after the task branched, the task never touched it); anything else is
 * `taskChanged`. `null` when the tip cannot be fetched or git cannot answer.
 */
export function defaultClassifyAgainstDefaultTip(
  worktreePath: string,
  head: string,
  tip: string,
  paths: readonly string[],
  remoteUrl: string | null
): DefaultTipClassification | null {
  const classified: DefaultTipClassification = { sameAsTip: [], mainDrift: [], taskChanged: [] }
  if (paths.length === 0) return classified
  if (!ensureDefaultTipObject(worktreePath, tip, remoteUrl)) return null
  const base = gitOk(worktreePath, ['merge-base', head, tip])
  if (!base) return null
  const atHead = treeEntriesAt(worktreePath, head, paths)
  const atTip = treeEntriesAt(worktreePath, tip, paths)
  const atBase = treeEntriesAt(worktreePath, base, paths)
  if (atHead === null || atTip === null || atBase === null) return null
  for (const path of paths) {
    const content = atHead.get(path) ?? null
    if (content === (atTip.get(path) ?? null)) classified.sameAsTip.push(path)
    else if (content === (atBase.get(path) ?? null)) classified.mainDrift.push(path)
    else classified.taskChanged.push(path)
  }
  return classified
}

/** The driver's rebase of the task's own commits onto the default branch's tip. */
export type RebaseOntoTipResult = { ok: true; head: string } | { ok: false; conflictFiles: string[]; reason: string }

/** Whether the worktree is stopped inside a rebase. */
export function rebaseInProgress(worktreePath: string): boolean {
  return ['rebase-merge', 'rebase-apply'].some((name) => {
    const path = gitOk(worktreePath, ['rev-parse', '--git-path', name])
    return path !== null && existsSync(resolve(worktreePath, path))
  })
}

/** What the driver's pre-turn merge of the default branch did: nothing to do, a merge commit, or a refusal (a conflict it aborted, or a worktree it left alone). */
export type MergeDefaultTipResult =
  | { ok: true; merged: false; head: string }
  | { ok: true; merged: true; oldHead: string; head: string }
  | { ok: false; conflictFiles: string[]; reason: string }

/** Whether the worktree is stopped inside a merge. */
export function mergeInProgress(worktreePath: string): boolean {
  const path = gitOk(worktreePath, ['rev-parse', '--git-path', 'MERGE_HEAD'])
  return path !== null && existsSync(resolve(worktreePath, path))
}

/**
 * Merges the default branch's `tip` into the worktree's branch with an ordinary
 * `git merge --no-edit`, when the tip is not already an ancestor of the head.
 * Never rebases, resets or stashes: a worktree with uncommitted tracked changes
 * is refused untouched, and a merge that stops is aborted with `git merge
 * --abort`, so the head is where it was and no merge is in progress, before the
 * conflicting files are returned.
 */
export function defaultMergeDefaultTip(
  worktreePath: string,
  tip: string,
  remoteUrl: string | null
): MergeDefaultTipResult {
  const refuse = (reason: string, conflictFiles: string[] = []): MergeDefaultTipResult => ({
    ok: false,
    conflictFiles,
    reason
  })
  const oldHead = gitOk(worktreePath, ['rev-parse', 'HEAD'])
  if (!oldHead) return refuse('the worktree head could not be read')
  if (!ensureDefaultTipObject(worktreePath, tip, remoteUrl))
    return refuse(`the default branch tip ${tip} could not be fetched`)
  if (gitOk(worktreePath, ['merge-base', '--is-ancestor', tip, oldHead]) !== null)
    return { ok: true, merged: false, head: oldHead }
  const dirty = gitOk(worktreePath, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty === null) return refuse('the worktree status could not be read')
  if (dirty.length > 0) return refuse('the worktree has uncommitted tracked changes')
  const merged = spawnSync('git', ['-C', worktreePath, 'merge', '--no-edit', '--no-ff', '--no-autostash', tip], {
    encoding: 'utf8',
    env: { ...process.env, GIT_EDITOR: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (!merged.error && merged.status === 0 && !mergeInProgress(worktreePath)) {
    const head = gitOk(worktreePath, ['rev-parse', 'HEAD'])
    if (head) return { ok: true, merged: true, oldHead, head }
  }
  const conflictFiles = (gitOk(worktreePath, ['diff', '--name-only', '--diff-filter=U']) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (mergeInProgress(worktreePath)) gitOk(worktreePath, ['merge', '--abort'])
  const after = gitOk(worktreePath, ['rev-parse', 'HEAD'])
  if (after !== oldHead || mergeInProgress(worktreePath)) {
    return refuse(
      `the merge of ${tip} stopped and could not be undone: the head is at ${after ?? 'an unreadable commit'}, not ${oldHead}`,
      conflictFiles
    )
  }
  const output = `${merged.stdout ?? ''}\n${merged.stderr ?? ''}`
  return refuse(
    conflictFiles.length > 0
      ? `the merge of ${tip} conflicts`
      : `the merge of ${tip} failed: ${firstErrorLine(output, merged.error?.message ?? `exit ${merged.status ?? 'unknown'}`)}`,
    conflictFiles
  )
}

/**
 * Rebases the worktree's own commits onto `tip` with `git rebase <tip>`. Refuses
 * without rebasing when the worktree has uncommitted tracked changes, or when
 * the range from the merge base to the head holds a merge commit, which a
 * rebase would drop along with any resolution made inside it. A rebase that
 * stops is aborted, and the head is checked back at its old value with no
 * rebase in progress, before the conflicting files are returned.
 */
export function defaultRebaseOntoDefaultTip(
  worktreePath: string,
  tip: string,
  remoteUrl: string | null
): RebaseOntoTipResult {
  const refuse = (reason: string, conflictFiles: string[] = []): RebaseOntoTipResult => ({
    ok: false,
    conflictFiles,
    reason
  })
  const oldHead = gitOk(worktreePath, ['rev-parse', 'HEAD'])
  if (!oldHead) return refuse('the worktree head could not be read')
  const dirty = gitOk(worktreePath, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty === null) return refuse('the worktree status could not be read')
  if (dirty.length > 0) return refuse('the worktree has uncommitted tracked changes')
  if (!ensureDefaultTipObject(worktreePath, tip, remoteUrl))
    return refuse(`the default branch tip ${tip} could not be fetched`)
  const base = gitOk(worktreePath, ['merge-base', 'HEAD', tip])
  if (!base) return refuse(`the worktree head has no merge base with ${tip}`)
  const merges = gitOk(worktreePath, ['rev-list', '--merges', `${base}..HEAD`])
  if (merges === null) return refuse(`the commits since ${base} could not be listed`)
  if (merges.length > 0) {
    return refuse(`the branch's own commits since ${base} include a merge commit, which a rebase would drop`)
  }
  const rebased = spawnSync(
    'git',
    ['-C', worktreePath, '-c', 'rebase.updateRefs=false', 'rebase', '--no-autostash', tip],
    {
      encoding: 'utf8',
      env: { ...process.env, GIT_EDITOR: 'true' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  if (!rebased.error && rebased.status === 0 && !rebaseInProgress(worktreePath)) {
    const head = gitOk(worktreePath, ['rev-parse', 'HEAD'])
    if (head) return { ok: true, head }
  }
  const conflictFiles = (gitOk(worktreePath, ['diff', '--name-only', '--diff-filter=U']) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (rebaseInProgress(worktreePath)) gitOk(worktreePath, ['rebase', '--abort'])
  const after = gitOk(worktreePath, ['rev-parse', 'HEAD'])
  if (after !== oldHead || rebaseInProgress(worktreePath)) {
    return refuse(
      `the rebase onto ${tip} stopped and could not be undone: the head is at ${after ?? 'an unreadable commit'}, not ${oldHead}`,
      conflictFiles
    )
  }
  const output = `${rebased.stdout ?? ''}\n${rebased.stderr ?? ''}`
  return refuse(
    conflictFiles.length > 0
      ? `the rebase onto ${tip} conflicts`
      : `the rebase onto ${tip} failed: ${firstErrorLine(output, rebased.error?.message ?? `exit ${rebased.status ?? 'unknown'}`)}`,
    conflictFiles
  )
}

/**
 * Puts the worktree's branch back at `head` after a rebase whose push did not
 * land: the rebased commits are copies of the ones at `head`, so nothing is
 * lost, and `--keep` refuses rather than discard an uncommitted change.
 */
export function defaultRestoreWorktreeHead(worktreePath: string, head: string): boolean {
  gitOk(worktreePath, ['reset', '-q', '--keep', head])
  return gitOk(worktreePath, ['rev-parse', 'HEAD']) === head
}

/**
 * The lower bound that measures only the task's own changes: `pushedBase`
 * itself when it is an ancestor of the worktree's head, else its merge base with
 * that head, so changes that reached the remote branch or the default branch
 * without being the task's are never counted as the task's. Falls back to
 * `pushedBase` when git cannot tell.
 */
export function ownChangesRangeBase(worktreePath: string, pushedBase: string | null): string | null {
  if (pushedBase === null) return null
  try {
    execFileSync('git', ['-C', worktreePath, 'merge-base', '--is-ancestor', pushedBase, 'HEAD'], { stdio: 'ignore' })
    return pushedBase
  } catch (err) {
    if ((err as { status?: number }).status !== 1) return pushedBase
  }
  const mergeBase = gitOk(worktreePath, ['merge-base', pushedBase, 'HEAD'])
  return mergeBase ? mergeBase.trim() : pushedBase
}

/**
 * O1/O2: the worktree's own uncommitted-and-committed diff text since `base`
 * (`git diff --unified=0 <base>`, run inside the worktree so a linked
 * worktree's own working-tree state is what is compared, never the main
 * checkout's) — what the after-turn credential scan reads. `null` on any
 * failure, so the scan simply has nothing to read rather than treating an
 * unreadable diff as clean.
 *
 * Round 3 review, LOW: `git diff` never lists an untracked file regardless
 * of flags, so a recognized credential value written into a brand-new
 * unstaged file would otherwise reach the driver's commit unscanned. Each
 * untracked file's own raw content (`git ls-files --others
 * --exclude-standard`, read directly off the worktree) is appended, never
 * diffed, named by its own path so a finding's `location` still points
 * somewhere real. An unreadable file fails the scan closed before publication.
 */
export function defaultGitWorktreeDiffText(worktreePath: string, base: string): string | null {
  let text: string | null
  try {
    text = execFileSync('git', ['-C', worktreePath, 'diff', '--unified=0', base], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024
    })
  } catch {
    return null
  }
  let untrackedPaths: string[] = []
  try {
    untrackedPaths = execFileSync('git', ['-C', worktreePath, 'ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return null
  }
  for (const path of untrackedPaths) {
    try {
      const content = readFileSync(join(worktreePath, path), 'utf8')
      text += `\n--- untracked: ${path} ---\n${content
        .split(/\r?\n/)
        .map((line) => `+${line}`)
        .join('\n')}`
    } catch {
      return null
    }
  }
  return text
}

/**
 * O2: stages everything and makes ONE commit under `header`, returning the
 * new HEAD sha. Runs the repository's own `commit-msg`/`pre-commit` hooks
 * (never `--no-verify`) — a hook that refuses throws, surfaced by the caller.
 */
export type CommitWorktreeResult =
  | { ok: true; sha: string }
  | { ok: false; check: 'commit-hook'; errorLine: string; output: string }

/** True only when Git's own trace says a commit hook exited non-zero. */
export function traceHasRefusingHook(trace: string, names: ReadonlySet<string>): boolean {
  const hooks = new Set<number>()
  for (const line of trace.split('\n')) {
    try {
      const event = JSON.parse(line) as {
        event?: string
        child_id?: number
        child_class?: string
        hook_name?: string
        code?: number
      }
      if (
        event.event === 'child_start' &&
        event.child_class === 'hook' &&
        typeof event.hook_name === 'string' &&
        names.has(event.hook_name) &&
        typeof event.child_id === 'number'
      ) {
        hooks.add(event.child_id)
      }
      if (
        event.event === 'child_exit' &&
        typeof event.child_id === 'number' &&
        hooks.has(event.child_id) &&
        typeof event.code === 'number' &&
        event.code !== 0
      ) {
        return true
      }
    } catch {
      // Trace2 is newline-delimited JSON; an unreadable line proves nothing.
    }
  }
  return false
}

export type PublicationRefusal = {
  kind: 'refused'
  check: string
  errorLine: string
  reason: string
  signature: string
}
