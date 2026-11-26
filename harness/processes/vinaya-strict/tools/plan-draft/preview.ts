/**
 * A plan draft previewed exactly as it will be read once published.
 *
 * Each task of a draft is rendered the way dispatch renders a published task —
 * the same Issue, the same brief — from the draft's own text, so a Planner and
 * a reviewer read what the Developer will read before any Issue exists. Three
 * things make the preview trustworthy:
 *
 *  - It renders from a read-only copy of the code at the draft's captured
 *    revision, never from a working tree. An uncommitted edit in any checkout
 *    can neither refuse nor change a preview. A revision the checkout does not
 *    hold, or that is no longer on the default branch, is a finding — never a
 *    silent fall back to whatever is checked out.
 *  - A task whose dependency has not merged still previews in full. Whether it
 *    can start is reported beside it as `waiting` and never withholds it.
 *  - A task's edges resolve inside the draft: a bare number names the draft's
 *    task of that number, `#<n>` a published Issue.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckError } from '@harness/kernel/gates/checks/contract'
import {
  type AssembleAndRenderBriefResult,
  assembleAndRenderBriefForIssue,
  DRAFT_ISSUE_SENTINEL
} from '@harness/workflow/tools/task-contract/brief-assembly.js'
import { makeCheckError } from '@harness/workflow/tools/task-contract/forge/forge-write.js'
import { trancheLabel } from '@harness/workflow/tools/task-contract/forge/labels'
import { TITLE_PATTERN } from '@harness/workflow/tools/task-contract/forge/list-tasks'
import { type DraftTask, draftFingerprint, type PlanDraft } from './draft'

export const CHECK_DRAFT_REVISION = 'plan-draft-revision'
export const CHECK_DRAFT_PREVIEW = 'plan-draft-preview'

/** The Issue a draft task becomes: its title in the tranche's `[<slug>] <n> — <title>` form, its body verbatim, and its labels with the tranche's own. */
export type PublishedIssue = { title: string; body: string; labels: string[] }

export function publishedIssueOf(draft: PlanDraft, task: DraftTask): PublishedIssue {
  const title = TITLE_PATTERN.test(task.title) ? task.title : `[${draft.tranche}] ${task.number} — ${task.title}`
  const own = trancheLabel(draft.tranche)
  return { title, body: task.body, labels: task.labels.includes(own) ? [...task.labels] : [...task.labels, own] }
}

// --- the read-only copy of the captured revision ------------------------------------

function git(cwd: string, args: string[]): { ok: true; out: string } | { ok: false; out: string } {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return { ok: true, out }
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) }
  }
}

/** The ref the repository's default branch is read from locally, or `null` when the checkout names none. */
function defaultBranchRef(cwd: string): string | null {
  const head = git(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
  if (head.ok && head.out !== '') return head.out
  for (const candidate of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    if (git(cwd, ['rev-parse', '--verify', '-q', candidate]).ok) return candidate
  }
  return null
}

export type StagedRevision = { ok: true; dir: string; dispose: () => void } | { ok: false; finding: CheckError }

const revisionFinding = (message: string): { ok: false; finding: CheckError } => ({
  ok: false,
  finding: makeCheckError(
    CHECK_DRAFT_REVISION,
    message,
    'Re-capture the draft against a commit of the default branch this checkout holds (`git fetch`, then submit the draft again with that revision).'
  )
})

/**
 * A read-only copy of the code at `revision`: a clone of the checkout at `cwd`
 * that borrows its objects, checked out at exactly that commit, with the same
 * `origin` so the repository still names itself. It reads nothing from the
 * network and needs no credential. `dispose` removes it.
 */
export function stageRevision(revision: string, cwd: string = process.cwd()): StagedRevision {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return revisionFinding("this is not a git checkout, so the draft's revision cannot be read")
  if (!git(top.out, ['cat-file', '-e', `${revision}^{commit}`]).ok) {
    return revisionFinding(`the draft's revision ${revision} is unknown to this checkout`)
  }
  const defaultRef = defaultBranchRef(top.out)
  if (defaultRef !== null && !git(top.out, ['merge-base', '--is-ancestor', revision, defaultRef]).ok) {
    return revisionFinding(
      `the draft's revision ${revision} is not on the default branch (${defaultRef}) — it is stale`
    )
  }
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-draft-revision-'))
  const dispose = () => rmSync(dir, { recursive: true, force: true })
  const cloned = git(dir, ['clone', '--quiet', '--no-checkout', '--shared', top.out, dir])
  if (!cloned.ok) {
    dispose()
    return revisionFinding(`the draft's revision ${revision} could not be copied: ${cloned.out}`)
  }
  const checkedOut = git(dir, ['checkout', '--quiet', '--detach', revision])
  if (!checkedOut.ok) {
    dispose()
    return revisionFinding(`the draft's revision ${revision} could not be checked out: ${checkedOut.out}`)
  }
  const origin = git(top.out, ['remote', 'get-url', 'origin'])
  if (origin.ok && origin.out !== '') git(dir, ['remote', 'set-url', 'origin', origin.out])
  return { ok: true, dir, dispose }
}

/** Renders read the working directory, so two staged runs never overlap in one process. */
let staged: Promise<unknown> = Promise.resolve()

/**
 * Runs `work` with the working directory set to a read-only copy of `revision`
 * and restores it afterwards. The copy is the only thing `work` can see
 * through the checkout, so nothing uncommitted anywhere reaches it.
 */
export function inStagedRevision<T>(
  revision: string,
  work: () => Promise<T>,
  cwd: string = process.cwd()
): Promise<{ ok: true; value: T } | { ok: false; finding: CheckError }> {
  const run = staged.then(async () => {
    const copy = stageRevision(revision, cwd)
    if (!copy.ok) return copy
    const before = process.cwd()
    try {
      process.chdir(copy.dir)
      return { ok: true as const, value: await work() }
    } finally {
      process.chdir(before)
      copy.dispose()
    }
  })
  staged = run.catch(() => undefined)
  return run
}

// --- the preview -------------------------------------------------------------------

export type TaskPreview = {
  task: number
  issue: PublishedIssue
  /** The brief dispatch would freeze for this text; `null` when it cannot be rendered. */
  brief: string | null
  /** Each reason the task cannot start yet; empty when it can. Never withholds the brief. */
  waiting: string[]
  findings: CheckError[]
}

export type DraftPreview = {
  fingerprint: string
  revision: string
  tasks: TaskPreview[]
  /** Findings about the preview as a whole — the revision. */
  findings: CheckError[]
  ok: boolean
}

export type PreviewDeps = {
  /** The brief renderer; defaults to the one dispatch uses. */
  assemble?: typeof assembleAndRenderBriefForIssue
  /** The checkout the revision is read from; defaults to the working directory. */
  cwd?: string
}

/** The brief of one draft task as dispatch would render it, from the text and edges of the draft alone. */
export async function renderDraftTask(
  draft: PlanDraft,
  task: DraftTask,
  assemble: typeof assembleAndRenderBriefForIssue = assembleAndRenderBriefForIssue
): Promise<AssembleAndRenderBriefResult> {
  return assemble(task.issue ?? DRAFT_ISSUE_SENTINEL, publishedIssueOf(draft, task), {
    skipFreshness: true,
    preview: true,
    trancheDraft: {
      slug: draft.tranche,
      taskId: String(task.number),
      tasks: draft.tasks.map((t) => ({ id: String(t.number), issue: t.issue }))
    }
  })
}

/**
 * Previews the Issue and the brief of each task of `draft` (all of them, or
 * those numbered in `only`). A task that cannot be rendered carries the facts
 * it could not find as findings; the others still preview.
 */
export async function previewDraft(
  draft: PlanDraft,
  only: readonly number[] | null = null,
  deps: PreviewDeps = {}
): Promise<DraftPreview> {
  const chosen = draft.tasks.filter((t) => only === null || only.includes(t.number)).sort((a, b) => a.number - b.number)
  const base = { fingerprint: draftFingerprint(draft), revision: draft.revision }

  const rendered = await inStagedRevision(
    draft.revision,
    async () => {
      const out: TaskPreview[] = []
      for (const task of chosen) {
        const issue = publishedIssueOf(draft, task)
        const result = await renderDraftTask(draft, task, deps.assemble)
        if (result.ok) {
          out.push({ task: task.number, issue, brief: result.brief, waiting: result.waiting ?? [], findings: [] })
        } else {
          out.push({
            task: task.number,
            issue,
            brief: null,
            waiting: [],
            findings: result.missing.map((m) =>
              makeCheckError(
                CHECK_DRAFT_PREVIEW,
                `task ${task.number}: the brief cannot be rendered: ${m}`,
                'Supply the missing fact in that task of the draft, submit the draft again, then preview again.'
              )
            )
          })
        }
      }
      return out
    },
    deps.cwd
  )
  if (!rendered.ok) return { ...base, tasks: [], findings: [rendered.finding], ok: false }
  const tasks = rendered.value
  return { ...base, tasks, findings: [], ok: tasks.every((t) => t.findings.length === 0) }
}
