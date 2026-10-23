import { existsSync } from 'node:fs'
import {
  beyondSurfacePaths,
  carryLiveRecord,
  defaultControlStoreDeps,
  globCoversPath,
  isProtectedAdminPath,
  type IssueSurface,
  normalizeTouchedPath,
  withBeyondSurfaceBlock
} from '@attalabs/aeg-core'
import { authenticateWorkerInvocation, requestEffect, scopeTarget } from '../broker.js'
import { type AgentVendor, readLaunchRecord, realDispatchTeeRecoveryDeps } from '../dispatch.js'
import { controlStoreRoot } from '../effects.js'
import { appendDriverLine, appendRoleLine } from '../loop-log.js'
import { addedDiffLines, findCredentialPatterns } from '../worker-boundary.js'
import {
  type DeveloperModelRun,
  readDeveloperModelRuns,
  withDeveloperModelsLine
} from '../dev-review-loop/developer-dispatch.js'
import { fastForwardedOntoDefaultTip } from '../dev-review-loop/developer-publication.js'
import { resolveHead } from '../dev-review-loop/gate-reading.js'
import type { LoopDeps } from '../dev-review-loop.js'
import { sourceReceiptsPath, sourceStoreDir, readRequiredSourceManifest } from '../source-manifest.js'
import { devToolError, type DevToolContext } from './dev-tools-server.js'
import { createDeveloperDevToolContext, type DeveloperDevToolDeps } from './developer-dev-tools-context.js'
import { createFetchDocumentationTool } from './fetch-documentation.js'

/** What a turn's publication carries from one tool call to the next; the loop and the Engine each own one. */
export type LivePublicationState = {
  /** The worktree head captured right before the current Developer turn — what the publication check reads the head against. */
  turnPreHead: string | null
  /** The branch's base, recorded on the first publication; a base that changes any other way means the branch was re-pointed. */
  publicationExpectedBase: string | null
  /** The default branch's tip the Developer fast-forwarded onto, until the next landed push. */
  publicationFastForwardBase: string | null
  /** The conflicting files from the last mergeability read, until the next dispatch consumes them. */
  pendingConflictFiles: string[] | null
  /** The pre-push hook's own refusal text from the most recent refused push; cleared on a landed push. */
  lastPushRefusal: string | null
  /** Whether the current turn called any publication tool. */
  turnPublicationAttempted: boolean
  /** The refusal the turn's last publication attempt returned, else `null`. */
  turnPublicationRefusal: string | null
}

export function createLivePublicationState(publicationExpectedBase: string | null = null): LivePublicationState {
  return {
    turnPreHead: null,
    publicationExpectedBase,
    publicationFastForwardBase: null,
    pendingConflictFiles: null,
    lastPushRefusal: null,
    turnPublicationAttempted: false,
    turnPublicationRefusal: null
  }
}

/** The loop operations the live context reads; each runner supplies its own (the real ones, or a test's fakes). */
export type LiveDeveloperContextLoopDeps = Pick<
  LoopDeps,
  | 'findOpenPrForBranch'
  | 'fetchIssueTitle'
  | 'resolveHead'
  | 'readMergedDefaultCommit'
  | 'gitWorktreeChangedPaths'
  | 'readUnpushedWorkDetail'
  | 'readWorktreeHead'
  | 'gitMergeBase'
  | 'readDefaultBranchTip'
  | 'gitIsAncestor'
  | 'resolveTaskSurface'
  | 'readWorktreeBranch'
  | 'buildVendoredCliIfMissing'
  | 'gitWorktreeDiffText'
  | 'commitWorktree'
  | 'classifyAgainstDefaultTip'
  | 'rebaseOntoDefaultTip'
  | 'pushTaskBranch'
  | 'pushTaskBranchWithLease'
  | 'restoreWorktreeHead'
  | 'validatePrBodyForCreate'
  | 'openTaskPullRequest'
  | 'fetchPrBody'
  | 'updatePrBody'
  | 'refreshPrEvidence'
  | 'readPrView'
  | 'runWorktreeChecks'
  | 'fetchDocumentationDeps'
>

/** Runs `git push` for the task branch from its worktree, throwing `PushHookRefusal` for a refused pre-push hook and `LeasePushRejected` for a refused lease; supplied by the runner, which owns the push's output handling. */
export type PushBranch = (worktreePath: string, branch: string, lease?: string) => void

type PushTaskBranchInput = Parameters<LoopDeps['pushTaskBranch']>[0]
type PushTaskBranchWithLeaseInput = Parameters<LoopDeps['pushTaskBranchWithLease']>[0]

/** What the publication helpers read: the task, its branch and worktree, and the state one turn carries. */
export type LivePublicationScope = {
  d: LiveDeveloperContextLoopDeps
  task: number
  branch: string
  repo: { owner: string; repo: string } | null
  worktree: string
  /** The runtime directory the task's control files live under. */
  runtimeRoot: string
  loopLogPath: string
  state: LivePublicationState
}

export type LiveDeveloperContextParams = LivePublicationScope & {
  agent: AgentVendor
  /** The review round a publication is recorded under, read at each call. */
  round: () => number
  /** Loop-resident helpers the context calls, passed in so this module never imports the loop at run time. */
  helpers: {
    ownChangesRangeBase: (worktreePath: string, pushedBase: string | null) => string | null
    defaultGitWorktreeUntrackedPaths: (worktreePath: string) => string[]
    worktreeCheckEnv: (input: {
      branch: string
      prNumber: number | null
      body: string | null
      head?: string | null
    }) => Record<string, string>
  }
}

export function createLiveDeveloperContext(params: LiveDeveloperContextParams): DevToolContext {
  const {
    d,
    task,
    branch,
    repo,
    worktree,
    runtimeRoot: root,
    loopLogPath,
    state,
    helpers,
    round,
    agent: dispatchAgent
  } = params
  const scope: LivePublicationScope = params
  const prNumberNow = (): number | null => d.findOpenPrForBranch(branch)?.number ?? null
  const modelRuns = (): DeveloperModelRun[] => readDeveloperModelRuns(root, task)
  const issueTitle = (): string => {
    try {
      return d.fetchIssueTitle(task)
    } catch {
      return `[task ${task}]`
    }
  }
  const safeRemoteHead = (): string | null => {
    try {
      return d.resolveHead(branch)
    } catch {
      return null
    }
  }
  // One comparison point for every publication check: the default-branch
  // commit the turn merged in, else the conflict-retry's `origin/main`,
  // else the last pushed head. `extraPaths` are paths the turn rolled back
  // to an older default-branch state, which the merged commit cannot show.
  const defaultRemoteUrl = repo ? `https://github.com/${repo.owner}/${repo.repo}.git` : null
  const publicationRange = (remoteHead: string | null): { base: string | null; extraPaths: string[] } => {
    const pushedBase =
      state.publicationFastForwardBase ??
      helpers.ownChangesRangeBase(worktree, pushedCommitRangeBase(remoteHead, state.publicationExpectedBase))
    const merged = d.readMergedDefaultCommit(worktree, pushedBase, defaultRemoteUrl)
    if (merged) return { base: merged.commit, extraPaths: merged.regressedPaths }
    return {
      base: state.pendingConflictFiles !== null ? 'origin/main' : pushedBase,
      extraPaths: []
    }
  }
  const publicationChangedPaths = (range: { base: string | null; extraPaths: string[] }): string[] => [
    ...new Set([...(range.base ? d.gitWorktreeChangedPaths(worktree, range.base) : []), ...range.extraPaths])
  ]
  const worktreeChangedPaths = (): string[] => {
    const unpushed = d.readUnpushedWorkDetail(worktree)
    const range = publicationRange(safeRemoteHead())
    const diffPaths = publicationChangedPaths(range)
    const extraDirtyPaths = range.base ? helpers.defaultGitWorktreeUntrackedPaths(worktree) : unpushed.dirtyFiles
    return [...new Set([...diffPaths, ...extraDirtyPaths])]
  }
  const prChangedPaths = async (): Promise<string[] | null> => {
    const head = d.readWorktreeHead(worktree)
    if (head === null) return null
    let base: string
    try {
      base = await d.gitMergeBase(head)
    } catch {
      return null
    }
    const paths = d.gitWorktreeChangedPaths(worktree, base)
    const dirty = d.readUnpushedWorkDetail(worktree).dirtyFiles
    const changed = [...new Set([...paths, ...dirty])]
    return changed.length > 0 ? changed : null
  }
  let driverUnpushedCommit: { sha: string; parent: string | null } | null = null
  // The base of `driverUnpushedCommit` — a merge commit the driver made
  // moves it past the recorded base, and retrying that same head is no
  // re-pointed branch.
  let driverUnpushedCommitBase: string | null = null
  // The remote's default-branch tip, read only when the head moved and
  // equals it — the one case the fast-forward exception can accept.
  const readFastForwardTip = (worktreeHead: string | null): { sha: string; recordedHeadIsAncestor: boolean } | null => {
    if (worktreeHead === null || state.turnPreHead === null || worktreeHead === state.turnPreHead) return null
    const tip = d.readDefaultBranchTip(defaultRemoteUrl)
    if (tip === null || tip !== worktreeHead) return null
    let recordedHeadIsAncestor = false
    try {
      recordedHeadIsAncestor = d.gitIsAncestor(state.turnPreHead, tip)
    } catch {
      recordedHeadIsAncestor = false
    }
    return { sha: tip, recordedHeadIsAncestor }
  }
  // The protected administrative paths among `paths` the task's Surface
  // does not cover — exactly what the Broker's protected-path check refuses.
  const blockingPaths = (paths: readonly string[], surface: IssueSurface | null): string[] =>
    paths.filter(
      (path) =>
        isProtectedAdminPath(path) &&
        !(surface?.in.some((glob) => globCoversPath(glob, normalizeTouchedPath(path))) ?? false)
    )
  // A main-drift rebase or lease push that could not land: nothing was
  // pushed, and the Developer is told to merge the default branch at that
  // tip, the same instruction a merge conflict carries.
  const mainDriftConflict = (tip: string, files: readonly string[], reason: string) => {
    const fileList =
      files.length > 0 ? files.map((file) => `- ${file}`).join('\n') : '(no specific file could be determined)'
    const text = [
      `The default branch moved a protected path this task never changed, so the driver tried to rebase \`${branch}\` onto main ${tip} and could not: ${reason}. Nothing was pushed.`,
      `Merge the default branch at that tip without committing it: run \`git merge --no-commit ${tip}\` from this worktree, resolve the conflicting file(s) below, then call \`publish_changes\` again — it makes the merge commit. Conflicting file(s):`,
      fileList
    ].join('\n\n')
    state.lastPushRefusal = text
    return {
      ok: false as const,
      error: devToolError(
        'conflict',
        'same_attempt',
        'not_committed',
        'main-drift-rebase',
        text,
        `Run \`git merge --no-commit ${tip}\`, resolve the conflicting file(s), then call publish_changes again.`
      )
    }
  }
  // A refused push: the pre-push hook's own text goes back to the
  // Developer; any other refusal (a Broker refusal, a git failure) is
  // raised, as it always was.
  const pushRefused = (push: { refusal: string; hook: boolean }) => {
    if (!push.hook) throw new Error(`task branch push failed outside the pre-push hook: ${push.refusal}`)
    state.lastPushRefusal = push.refusal
    return {
      ok: false as const,
      error: devToolError(
        'policy_refusal',
        'same_attempt',
        'not_committed',
        'pre-push-hook',
        push.refusal,
        'Fix what the pre-push hook refused, then call publish_changes again.'
      )
    }
  }
  const deps: DeveloperDevToolDeps = {
    readPublicationCheckInput: async () => {
      const worktreeHead = d.readWorktreeHead(worktree)
      const base = await readPublicationBase(scope, worktreeHead)
      const defaultBranchTip = readFastForwardTip(worktreeHead)
      // A fast-forward onto the default branch's tip re-records the base
      // and the head at that tip, here, so this check and every later one
      // in the turn compare against it and measure changed paths from it.
      if (
        fastForwardedOntoDefaultTip({
          worktreeHead,
          recordedHead: state.turnPreHead,
          base,
          defaultBranchTip
        })
      ) {
        const tip = defaultBranchTip!.sha
        state.turnPreHead = tip
        state.publicationExpectedBase = tip
        state.publicationFastForwardBase = tip
      }
      return {
        worktreeBranch: d.readWorktreeBranch(worktree),
        expectedBranch: branch,
        worktreeHead,
        recordedHead: state.turnPreHead,
        remoteHead: safeRemoteHead(),
        driverUnpushedCommit,
        defaultBranchTip,
        base,
        expectedBase:
          driverUnpushedCommit !== null &&
          worktreeHead === driverUnpushedCommit.sha &&
          driverUnpushedCommitBase !== null
            ? driverUnpushedCommitBase
            : state.publicationExpectedBase,
        changedPaths: worktreeChangedPaths(),
        surface: d.resolveTaskSurface ? d.resolveTaskSurface(task) : null
      }
    },
    commitAndPush: async (header) => {
      const headerCredentials = findCredentialPatterns(header, 'the proposed commit header')
      if (headerCredentials.length > 0) {
        return {
          ok: false,
          error: devToolError(
            'policy_refusal',
            'same_attempt',
            'not_started',
            'credential-scan',
            `recognized credential pattern(s) in commit header: ${headerCredentials.map((finding) => finding.pattern).join(', ')}`,
            'Remove the credential-shaped value from the commit header.'
          )
        }
      }
      const remoteHeadBefore = safeRemoteHead()
      if (d.readUnpushedWorkDetail(worktree).dirtyFiles.length > 0) d.buildVendoredCliIfMissing(worktree)
      const scanBase = publicationRange(remoteHeadBefore).base
      if (scanBase === null) {
        return {
          ok: false,
          error: devToolError(
            'dependency_unavailable',
            'same_attempt',
            'not_started',
            'credential-scan',
            'the branch base could not be resolved before publication',
            'Restore the branch base and call publish_changes again.'
          )
        }
      }
      const diff = d.gitWorktreeDiffText(worktree, scanBase)
      if (diff === null) {
        return {
          ok: false,
          error: devToolError(
            'dependency_unavailable',
            'same_attempt',
            'not_started',
            'credential-scan',
            'the added diff lines could not be read before publication',
            'Restore a readable worktree and call publish_changes again.'
          )
        }
      }
      const credentials = findCredentialPatterns(addedDiffLines(diff), 'the added worktree diff')
      if (credentials.length > 0) {
        return {
          ok: false,
          error: devToolError(
            'policy_refusal',
            'same_attempt',
            'not_started',
            'credential-scan',
            `recognized credential pattern(s): ${credentials.map((finding) => finding.pattern).join(', ')}`,
            'Remove the credential-shaped addition before publishing.'
          )
        }
      }
      const unpushed = d.readUnpushedWorkDetail(worktree)
      if (unpushed.dirtyFiles.length > 0) {
        const committed = d.commitWorktree(worktree, header)
        if (!committed.ok) {
          return {
            ok: false,
            error: devToolError(
              'policy_refusal',
              'same_attempt',
              'not_started',
              committed.check,
              committed.output,
              'Fix what the commit hook refused, then call publish_changes again.'
            )
          }
        }
      }
      const localHead = d.readWorktreeHead(worktree)
      if (localHead !== null && localHead !== remoteHeadBefore) {
        // A commit made by this tool remains valid work if the push hook
        // refuses. Remember it so the next call can retry that same head.
        if (unpushed.dirtyFiles.length > 0) {
          state.turnPreHead = localHead
          driverUnpushedCommit = { sha: localHead, parent: remoteHeadBefore }
          driverUnpushedCommitBase = await readPublicationBase(scope, localHead)
        }
        const surface = d.resolveTaskSurface ? d.resolveTaskSurface(task) : null
        let changedPaths = publicationChangedPaths(publicationRange(remoteHeadBefore))
        // Measured against the default branch's tip as the remote reports
        // it: a path equal to that tip is no task change, and a blocking
        // protected path only the default branch moved is drift the driver
        // rebases away rather than refusing. An unreadable tip, or a
        // classification git cannot answer, keeps every path counted.
        const tip = d.readDefaultBranchTip(defaultRemoteUrl)
        const classified =
          tip === null ? null : d.classifyAgainstDefaultTip(worktree, localHead, tip, changedPaths, defaultRemoteUrl)
        if (classified !== null) {
          const sameAsTip = new Set(classified.sameAsTip)
          changedPaths = changedPaths.filter((path) => !sameAsTip.has(path))
        }
        const blocking = blockingPaths(changedPaths, surface)
        const mainDrift = new Set(classified?.mainDrift ?? [])
        const pushInput = {
          task,
          branch,
          sha: localHead,
          touchedPaths: changedPaths,
          surface,
          round: round(),
          agent: dispatchAgent,
          repo,
          worktreePath: worktree
        }
        if (tip !== null && blocking.length > 0 && blocking.every((path) => mainDrift.has(path))) {
          const rebased = d.rebaseOntoDefaultTip(worktree, tip, defaultRemoteUrl)
          if (!rebased.ok) return mainDriftConflict(tip, rebased.conflictFiles, rebased.reason)
          const rebasedInput = {
            ...pushInput,
            sha: rebased.head,
            touchedPaths: d.gitWorktreeChangedPaths(worktree, tip)
          }
          const push =
            remoteHeadBefore === null
              ? { ...d.pushTaskBranch(rebasedInput), lease: false }
              : d.pushTaskBranchWithLease({
                  ...rebasedInput,
                  expectedRemoteHead: remoteHeadBefore
                })
          if (!push.ok) {
            // Nothing landed: the branch goes back to the head the
            // Developer published from, so the recorded head and base
            // still describe it and the next publication starts over.
            const restored = d.restoreWorktreeHead(worktree, localHead)
            const restoreNote = restored
              ? ''
              : `; the worktree could not be moved back from the rebased ${rebased.head} to ${localHead}, so run \`git reset --keep ${localHead}\` before publishing again`
            if (push.lease) {
              return mainDriftConflict(
                tip,
                [],
                `the lease push was refused because the remote branch is no longer at ${remoteHeadBefore}: ${push.refusal}${restoreNote}`
              )
            }
            if (!restored && push.hook)
              return pushRefused({
                ...push,
                refusal: `${push.refusal}${restoreNote}`
              })
            return pushRefused(push)
          }
          // The rebased head landed on the tip: re-record the head and the
          // base there, as the fast-forward rule does, so the next
          // publication check compares against them.
          state.turnPreHead = rebased.head
          state.publicationExpectedBase = tip
          state.publicationFastForwardBase = tip
          appendDriverLine(
            loopLogPath,
            `Rebased ${branch} onto main ${tip} (${localHead} → ${rebased.head}) and pushed${remoteHeadBefore === null ? '' : ' with lease'}`,
            'done'
          )
        } else {
          const push = d.pushTaskBranch(pushInput)
          if (!push.ok) return pushRefused(push)
        }
        state.lastPushRefusal = null
      }
      driverUnpushedCommit = null
      driverUnpushedCommitBase = null
      state.publicationFastForwardBase = null
      const pushedHead = d.readWorktreeHead(worktree) ?? localHead ?? ''
      // A successful commit+push advances the worktree head. Move the
      // recorded pre-turn head forward to it so a SECOND (and third)
      // `publish_changes` in the same turn sees an unmoved head
      // (`checkPublicationPreconditions` compares `worktreeHead` against
      // `recordedHead`) rather than refusing on the very commit this tool
      // just made — a Developer may publish more than once per turn.
      if (pushedHead) state.turnPreHead = pushedHead
      // The publication pushed, so a base it moved forward (a merge from
      // the default branch) becomes the one later checks expect.
      if (pushedHead) await resolvePublicationBase(scope, pushedHead)
      await syncBeyondSurfaceRecord(scope, prNumberNow())
      return { ok: true, result: { pushedHead } }
    },
    validatePrBody: async (body, title) => {
      const bodyCredentials = findCredentialPatterns(body, 'the proposed PR body')
      if (bodyCredentials.length > 0) {
        return {
          ok: false,
          reason: `credential-scan: recognized credential pattern(s): ${bodyCredentials.map((finding) => finding.pattern).join(', ')}`
        }
      }
      const changedFiles = await prChangedPaths()
      if (changedFiles === null) {
        return {
          ok: false,
          reason: 'could not resolve the task’s changed files against its PR base'
        }
      }
      const errors = await d.validatePrBodyForCreate({
        body,
        title: title ?? issueTitle(),
        changedFiles,
        branch,
        baseBranch: 'main'
      })
      return errors.length === 0
        ? { ok: true }
        : {
            ok: false,
            reason: errors.map((e) => `${e.check}: ${e.message}`).join('; ')
          }
    },
    openPullRequest: async (title, body) => {
      const titleCredentials = findCredentialPatterns(title, 'the proposed PR title')
      if (titleCredentials.length > 0) {
        return {
          ok: false,
          error: devToolError(
            'policy_refusal',
            'same_attempt',
            'not_started',
            'credential-scan',
            `recognized credential pattern(s) in PR title: ${titleCredentials.map((finding) => finding.pattern).join(', ')}`,
            'Remove the credential-shaped value from the PR title.'
          )
        }
      }
      const existingPr = prNumberNow()
      if (existingPr !== null) {
        return {
          ok: false,
          error: devToolError(
            'conflict',
            'same_attempt',
            'not_started',
            'pr-exists',
            `pull request ${existingPr} is already open for branch ${branch}`,
            'Use update_pull_request_body to replace its body.'
          )
        }
      }
      const prNumber = d.openTaskPullRequest({
        task,
        branch,
        title,
        // A record of `[live]` runs is the driver's alone: none exists before the pull request does.
        body: carryLiveRecord(await withBeyondSurfaceRecord(scope, withDeveloperModelsLine(body, modelRuns())), null),
        round: round(),
        agent: dispatchAgent,
        repo
      })
      if (prNumber === null) {
        return {
          ok: false,
          error: devToolError(
            'internal',
            'new_attempt',
            'uncertain',
            'pr-open',
            'the pull-request open could not be confirmed',
            'Reconcile the forge state before calling open_pull_request again.'
          )
        }
      }
      return { ok: true, result: { prNumber } }
    },
    updatePullRequestBody: async (body) => {
      const prNumber = prNumberNow()
      if (prNumber === null) {
        return {
          ok: false,
          error: devToolError(
            'dependency_unavailable',
            'same_attempt',
            'not_started',
            'no-open-pr',
            `no open pull request for branch ${branch}`,
            'Open the pull request with open_pull_request first.'
          )
        }
      }
      // The `AEG:LIVE` record is the driver's: the live body's record is
      // carried over, so an agent edit to it never survives. A live body
      // that cannot be read keeps none — the next live run writes it.
      let currentBody: string | null
      try {
        currentBody = d.fetchPrBody(prNumber)
      } catch {
        currentBody = null
      }
      await d.updatePrBody({
        prNumber,
        body: carryLiveRecord(
          await withBeyondSurfaceRecord(scope, withDeveloperModelsLine(body, modelRuns())),
          currentBody
        ),
        repo
      })
      return { ok: true, result: { prNumber } }
    },
    refreshEvidence: async () => {
      const prNumber = prNumberNow()
      if (prNumber === null) {
        return {
          ok: false,
          error: devToolError(
            'dependency_unavailable',
            'same_attempt',
            'not_started',
            'no-open-pr',
            `no open pull request for branch ${branch}`,
            'Open the pull request with open_pull_request first.'
          )
        }
      }
      const result = await d.refreshPrEvidence({
        worktreePath: worktree,
        prNumber,
        round: round(),
        repo
      })
      await syncBeyondSurfaceRecord(scope, prNumber)
      return { ok: true, result }
    },
    readPullRequest: async () => ({
      ok: true,
      result: await d.readPrView({ branch, repo })
    }),
    runChecks: async () => {
      const pr = await d.readPrView({ branch, repo })
      const env = helpers.worktreeCheckEnv({
        branch,
        prNumber: pr.prNumber,
        body: pr.body,
        head: pr.head
      })
      return { ok: true, result: await d.runWorktreeChecks(worktree, env) }
    },
    fetchDocumentation: createFetchDocumentationTool({
      receiptsPath: sourceReceiptsPath(sourceStoreDir(root, task)),
      manifest: () => readRequiredSourceManifest(sourceStoreDir(root, task)),
      ...(d.fetchDocumentationDeps ? { deps: d.fetchDocumentationDeps } : {})
    }),
    onPublicationAttempt: (result) => {
      state.turnPublicationAttempted = true
      state.turnPublicationRefusal = result.ok
        ? null
        : `${result.error.errorClass}/${result.error.retryDisposition}/${result.error.effectState}: ${result.error.check}: ${result.error.output}`
    }
  }
  return createDeveloperDevToolContext(deps)
}

/** `body` with its `AEG:BEYOND-SURFACE` block rewritten to list every path the task branch changed (from its merge base, the same three-dot diff the `surface-scope` check reads) that the task's Surface does not cover — the driver's own marked region, replaced on every body write the way the `**For:**` line is, so an agent edit to it never survives. The block is written empty when the Surface, the head or the merge base cannot be read, so a list the agent wrote never survives a read failure. */
export async function withBeyondSurfaceRecord(scope: LivePublicationScope, body: string): Promise<string> {
  const { d, task, worktree } = scope
  const surface = d.resolveTaskSurface ? d.resolveTaskSurface(task) : null
  if (!surface) return withBeyondSurfaceBlock(body, [])
  try {
    const head = d.readWorktreeHead(worktree)
    if (head === null) return withBeyondSurfaceBlock(body, [])
    const base = await d.gitMergeBase(head)
    return withBeyondSurfaceBlock(body, beyondSurfacePaths(d.gitWorktreeChangedPaths(worktree, base), surface))
  } catch {
    return withBeyondSurfaceBlock(body, [])
  }
}

/** Rewrite the open pull request's `AEG:BEYOND-SURFACE` block after the branch moved — a no-op with no open pull request or no change to the block. Never throws: a failed write is logged, and the next body write records it. */
export async function syncBeyondSurfaceRecord(scope: LivePublicationScope, pr: number | null): Promise<void> {
  const { d, repo, loopLogPath } = scope
  if (pr === null) return
  try {
    const body = d.fetchPrBody(pr)
    const next = await withBeyondSurfaceRecord(scope, body)
    if (next !== body) await d.updatePrBody({ prNumber: pr, body: next, repo })
  } catch (err) {
    appendRoleLine(
      loopLogPath,
      'dev-review-loop',
      `beyond_surface_update_failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** The task branch's base (its merge base with the default branch) for `worktreeHead`, recording nothing — the publication check compares it against the base recorded before the attempt, so a refused attempt never moves that expectation. Never throws. */
export async function readPublicationBase(
  scope: LivePublicationScope,
  worktreeHead: string | null
): Promise<string | null> {
  const { d, state } = scope
  if (worktreeHead === null) return state.publicationExpectedBase
  try {
    return await d.gitMergeBase(worktreeHead)
  } catch {
    return null
  }
}

/**
 * O7: read the task branch's base and record it as the expected base when
 * none is recorded yet or it descends from the recorded one — the base a
 * merge from the default branch legitimately moves forward. Called only at
 * a Developer turn start and after a publication that pushed, never from
 * the publication check's input, so a refused rebase cannot advance it.
 * A base that changes any other way means the branch was re-pointed, which
 * the publication check refuses. Never throws.
 */
export async function resolvePublicationBase(
  scope: LivePublicationScope,
  worktreeHead: string | null
): Promise<string | null> {
  const { d, state } = scope
  if (worktreeHead === null) return state.publicationExpectedBase
  const base = await readPublicationBase(scope, worktreeHead)
  if (
    base !== null &&
    (state.publicationExpectedBase === null || d.gitIsAncestor(state.publicationExpectedBase, base))
  ) {
    state.publicationExpectedBase = base
  }
  return base
}

/**
 * The four calls that write effect and ownership records into the control
 * store (commit and push, open pull request, replace the body, refresh
 * evidence) and `fetchDocumentation`, whose read receipt is a protected path
 * the driver writes, run inside `driverToolCall`, so those records are
 * attributed to the driver and a control-store write the worker made between
 * tool calls is still reported. `readPullRequest` and `runChecks` write no
 * control record and stay unwrapped: wrapping a call widens the window in
 * which a concurrent worker write is attributed to the driver.
 */
export function attributeDriverToolCalls(
  context: DevToolContext,
  driverToolCall: <T>(call: () => Promise<T>) => Promise<T>
): DevToolContext {
  return {
    publishChanges: (header) => driverToolCall(() => context.publishChanges(header)),
    openPullRequest: (title, body) => driverToolCall(() => context.openPullRequest(title, body)),
    updatePullRequestBody: (body) => driverToolCall(() => context.updatePullRequestBody(body)),
    refreshEvidence: () => driverToolCall(() => context.refreshEvidence()),
    readPullRequest: () => context.readPullRequest(),
    runChecks: () => context.runChecks(),
    fetchDocumentation: (input) => driverToolCall(() => context.fetchDocumentation(input))
  }
}

export function firstErrorLine(output: string, fallback: string): string {
  return (
    output
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? fallback
  )
}

/** The developer launch record's `runId`, or `null` when no usable record names this task — what the broker context is authenticated from (O3). */
export function developerRunIdFor(
  agent: AgentVendor,
  repo: { owner: string; repo: string } | null,
  task: number
): string | null {
  const parsed = readLaunchRecord('developer', agent, repo, task)
  return parsed.status === 'ok' ? parsed.record.runId : null
}

/** A lease push git refused because the remote branch is no longer at the expected head. */
export class LeasePushRejected extends Error {
  constructor(readonly output: string) {
    super(output)
    this.name = 'LeasePushRejected'
  }
}

export class PushHookRefusal extends Error {
  constructor(readonly output: string) {
    super(firstErrorLine(output, 'pre-push hook refused with no captured output'))
    this.name = 'PushHookRefusal'
  }
}

/**
 * O3/O4: pushes the task branch through the Broker's governed `branch-push`
 * operation. The invocation context is authenticated from the Developer's own
 * launch record — never a hand-built context — so the push is authorized for
 * this task and recorded as an effect. The push runs from the task worktree
 * so the repository's own pre-push hook runs exactly where a Developer's push
 * once did; a hook that refuses makes `execFileSync` throw, and its own
 * refusal text (stderr) is returned as `refusal` (O4), never raised.
 */
export function defaultPushTaskBranch(
  input: PushTaskBranchInput,
  pushBranch: PushBranch
): { ok: true } | { ok: false; refusal: string; hook: boolean } {
  const result = pushTaskBranchThroughBroker(input, pushBranch, 'branch-push')
  return result.ok ? { ok: true } : { ok: false, refusal: result.refusal, hook: result.hook }
}

/**
 * O2: the driver's own force-with-lease push of the task branch after it
 * rebased that branch onto the default branch's tip, through the Broker's
 * `branch-lease-push` operation — authenticated from the Developer's launch
 * record exactly like `defaultPushTaskBranch`, and refused by the Broker for
 * any target outside `refs/heads/task/`. The lease names the remote head read
 * before the publish, so a remote branch that moved since is never
 * overwritten. No Developer tool reaches this.
 */
export function defaultPushTaskBranchWithLease(
  input: PushTaskBranchWithLeaseInput,
  pushBranch: PushBranch
): { ok: true } | { ok: false; refusal: string; hook: boolean; lease: boolean } {
  const result = pushTaskBranchThroughBroker(input, pushBranch, 'branch-lease-push', input.expectedRemoteHead)
  return result.ok ? { ok: true } : result
}

/**
 * Both task-branch pushes through the Broker: authenticated from the
 * Developer's own launch record — never a hand-built context — so the push is
 * authorized for this task and recorded as an effect. The push runs from the
 * task worktree so the repository's own pre-push hook runs exactly where a
 * Developer's push once did; a hook refusal is returned with its own text
 * (O4), never raised.
 */
function pushTaskBranchThroughBroker(
  input: PushTaskBranchInput,
  pushBranch: PushBranch,
  operation: 'branch-push' | 'branch-lease-push',
  lease?: string
): { ok: true } | { ok: false; refusal: string; hook: boolean; lease: boolean } {
  const runId = developerRunIdFor(input.agent, input.repo, input.task)
  if (runId === null) {
    return {
      ok: false,
      refusal: `no developer launch record for task ${input.task} to authenticate the push against`,
      hook: false,
      lease: false
    }
  }
  let context: ReturnType<typeof authenticateWorkerInvocation>
  try {
    context = authenticateWorkerInvocation(
      {
        VINAYA_ROLE: 'developer',
        VINAYA_TASK: String(input.task),
        VINAYA_RUN_ID: runId
      },
      realDispatchTeeRecoveryDeps()
    )
  } catch (err) {
    return {
      ok: false,
      refusal: err instanceof Error ? err.message : String(err),
      hook: false,
      lease: false
    }
  }
  try {
    requestEffect(defaultControlStoreDeps(controlStoreRoot), context, {
      operation,
      target: scopeTarget(input.task, `refs/heads/${input.branch}`),
      inputVersion: input.round,
      touchedPaths: input.touchedPaths,
      surfaceCoversPath: (path) => input.surface?.in.some((glob) => globCoversPath(glob, path)) ?? false,
      key: `${operation}-${input.sha}`,
      payload: input.sha,
      poster: () => {
        pushBranch(input.worktreePath, input.branch, lease)
        return input.sha
      },
      reconcile: () => {
        let head: string | null
        try {
          head = resolveHead(input.branch)
        } catch {
          head = null
        }
        return head === input.sha ? { outcome: 'confirmed', url: input.sha } : { outcome: 'absent' }
      }
    })
    return { ok: true }
  } catch (err) {
    // A pre-push hook refusal surfaces as the poster's push throwing with the
    // hook's own output on the error; any broker/credential refusal surfaces
    // the same way. Either is a failed push, returned for the existing
    // mechanical-failure path to carry (O4), never raised.
    const message =
      err instanceof PushHookRefusal || err instanceof LeasePushRejected
        ? err.output
        : err instanceof Error
          ? err.message
          : String(err)
    return {
      ok: false,
      refusal: message.trim() || 'the push was refused with no captured output',
      hook: err instanceof PushHookRefusal,
      lease: err instanceof LeasePushRejected
    }
  }
}

/** The exclusive lower bound for the commits authorized by one push. */
export function pushedCommitRangeBase(remoteHead: string | null, branchBase: string | null): string | null {
  return remoteHead ?? branchBase
}

export type UnpushedWork = { dirtyFiles: string[]; aheadCount: number }

export type PublishDeveloperTurnDeps<T> = {
  worktreePath: string
  branch: string
  turnPreStop: string | null
  findOpenPullRequest: () => T | null
  readUnpushedWork: (worktreePath: string) => UnpushedWork
  fetchDeveloperStop: () => { identity: string } | null
  noPushDetail: (branch: string, work: UnpushedWork) => string
  refusal: (check: string, detail: string) => unknown
}

/** Detects work a Developer turn left unpublished; it never writes or pushes. */
export function publishDeveloperTurn<T>(deps: PublishDeveloperTurnDeps<T>): { kind: 'nothing' } | unknown {
  if (!existsSync(deps.worktreePath)) return { kind: 'nothing' }
  const existingPr = deps.findOpenPullRequest()
  const unpushed = deps.readUnpushedWork(deps.worktreePath)
  const currentStop = deps.fetchDeveloperStop()
  if (currentStop !== null && currentStop.identity !== deps.turnPreStop) return { kind: 'nothing' }
  if (unpushed.dirtyFiles.length === 0 && unpushed.aheadCount === 0) return { kind: 'nothing' }
  const missingPr = existingPr ? '' : '; no open pull request'
  return deps.refusal(
    'unpublished-work',
    `work the turn left unpublished — ${deps.noPushDetail(deps.branch, unpushed)}${missingPr}`
  )
}

/** Prompt used after a publication refusal or any other unpublished turn. */
export function commitAndPushPrompt(lastPushRefusal: string | null, publishingInstruction: string): string {
  const refusalBlock = lastPushRefusal
    ? `\n\nYour last \`publish_changes\` for this branch was refused by the pre-push hook:\n\n${lastPushRefusal}\n\nFix the cause of that refusal before calling \`publish_changes\` again.`
    : ''
  return [
    'Your previous turn left work that is not yet on the remote.',
    `Per your role doctrine (\`bun apps/cli/src/index.ts doctrine --role developer --print\`): ${publishingInstruction}${refusalBlock}`
  ].join('\n\n')
}
