import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { DevReviewLoopEventInput } from '@attalabs/aeg-core'
import type { DevToolContext } from '../../../apps/cli/src/lib/task-tools/dev-tools-server'
import { storagePushEvent } from '../../../apps/cli/src/lib/flow-v2-events'
import { gitPath, readLastPushResult } from '../../../apps/cli/src/lib/pre-push-failed-tests'
import { PUSH_MODE_MARKER } from '../../../apps/cli/src/lib/pre-push-mode-logic'
import type { ReadyGateResult, StagedPullRequest, V2Functions } from '../executing/v2-actions'

// The live wiring of review locally, push once (version 2 of the developer-review Flow) for the Engine runner: the
// staged pull request the Developer's `open_pull_request` saves, the storage-push marker its worktree's pre-push hook
// reads, the ready push (the hook run in its ready mode), and the opening of the pull request once both reviewers
// approved. Everything here is a thin shell over git, the hook and the Developer's own driver tools.

/** Where the run keeps the staged pull request: its run directory, never the repository. */
export const stagedPullRequestPath = (runDir: string): string => join(runDir, 'staged-pull-request.json')

/** The staged pull request, read and written as one small file. */
export function stagedPullRequestStore(runDir: string): {
  read: () => StagedPullRequest | null
  write: (staged: StagedPullRequest) => void
} {
  const path = stagedPullRequestPath(runDir)
  return {
    read: () => {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<StagedPullRequest>
        return typeof value.title === 'string' && typeof value.body === 'string'
          ? { title: value.title, body: value.body }
          : null
      } catch {
        return null
      }
    },
    write: (staged) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(staged)}\n`, { mode: 0o600 })
    }
  }
}

/** Marks the worktree's pushes as storage pushes (the hook confirms no pull request is open before honouring it). */
export function beginStoragePushes(worktreePath: string): void {
  const path = gitPath(worktreePath, PUSH_MODE_MARKER)
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'storage\n')
}

/** Ends storage pushes for the worktree: its pushes run the selected tests again. */
export function endStoragePushes(worktreePath: string): void {
  const path = gitPath(worktreePath, PUSH_MODE_MARKER)
  if (path) rmSync(path, { force: true })
}

/**
 * The Developer's driver tools in version 2. While no pull request is open, `publish_changes` is a storage push
 * (the worktree is marked before it pushes, and each push that lands is reported), `open_pull_request` saves the
 * title and body instead of opening, and `update_pull_request_body` replaces the saved body. Once a pull request is
 * open, every tool is the version 1 one.
 */
export function withV2DevTools(
  base: DevToolContext,
  options: {
    worktreePath: string
    store: ReturnType<typeof stagedPullRequestStore>
    findOpenPullRequest: () => { number: number } | null
    onStoragePush: (head: string) => void
  }
): DevToolContext {
  const openPr = (): { number: number } | null => {
    try {
      return options.findOpenPullRequest()
    } catch {
      return null
    }
  }
  return {
    ...base,
    publishChanges: async (header) => {
      const storage = openPr() === null
      if (storage) beginStoragePushes(options.worktreePath)
      const result = await base.publishChanges(header)
      if (storage && result.ok) options.onStoragePush(result.result.pushedHead)
      return result
    },
    openPullRequest: async (title, body) => {
      if (openPr() !== null) return base.openPullRequest(title, body)
      options.store.write({ title, body })
      return {
        ok: true,
        result: {
          prNumber: 0,
          staged: true,
          note: 'Saved. In this flow the pull request opens after both reviewers approve and the ready push passes; finish your turn.'
        } as unknown as { prNumber: number }
      }
    },
    updatePullRequestBody: async (body) => {
      if (openPr() !== null) return base.updatePullRequestBody(body)
      const staged = options.store.read()
      options.store.write({ title: staged?.title ?? '', body })
      return {
        ok: true,
        result: { prNumber: 0, staged: true } as unknown as { prNumber: number }
      }
    }
  }
}

/** The worktree's pre-push hook: `core.hooksPath` when set (relative to the worktree), else the git hooks folder. */
export function prePushHookPath(worktreePath: string): string | null {
  const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: worktreePath, encoding: 'utf8' })
  const hooksPath = configured.status === 0 ? configured.stdout.trim() : ''
  const dir = hooksPath
    ? isAbsolute(hooksPath)
      ? hooksPath
      : join(worktreePath, hooksPath)
    : (gitPath(worktreePath, 'hooks') ?? join(worktreePath, '.git', 'hooks'))
  const hook = join(dir, 'pre-push')
  return existsSync(hook) ? hook : null
}

/** Thirty minutes: the ready push's selected tests, after which the run reads it as refused. */
const READY_GATE_TIMEOUT_MS = 30 * 60 * 1000

/**
 * The ready push: the worktree's own pre-push hook, run in its ready mode on the approved head with the default
 * branch as its base (storage pushes already moved the branch's upstream there). The approved head is already on
 * the remote, so the hook is run as the push would run it — with the push's own ref line on its stdin — rather
 * than through a push that has nothing left to send. The hook's last-push record says what it selected and what
 * failed. A repository with no pre-push hook has nothing to run: the push passes.
 */
export function runReadyGateLive(input: {
  worktreePath: string
  branch: string
  head: string
  remoteHead: string | null
  defaultBranch?: string
  now?: () => number
}): ReadyGateResult {
  const now = input.now ?? (() => Date.now())
  const hook = prePushHookPath(input.worktreePath)
  if (hook === null) return { passed: true, output: 'no pre-push hook to run', selection: null, failed: [], wallMs: 0 }
  const started = now()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VINAYA_PUSH_MODE: 'ready',
    VINAYA_PUSH_BASE: `origin/${input.defaultBranch ?? 'main'}`
  }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  const ref = `refs/heads/${input.branch}`
  const run = spawnSync('sh', [hook, 'origin', 'origin'], {
    cwd: input.worktreePath,
    env,
    input: `${ref} ${input.head} ${ref} ${input.remoteHead ?? '0000000000000000000000000000000000000000'}\n`,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: READY_GATE_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  })
  const wallMs = Math.max(0, now() - started)
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}${run.signal ? `\nthe ready push was stopped by ${run.signal}` : ''}`
  const record = readLastPushResult(input.worktreePath)
  const fresh = record !== null && record.head === input.head
  const passed = run.status === 0
  return {
    passed,
    output,
    selection: fresh ? record.selection : null,
    failed: passed ? [] : fresh ? record.failed : 'all',
    wallMs
  }
}

/** Version 2's live functions for one task. */
export function liveV2Functions(input: {
  worktreePath: string
  branch: string
  store: ReturnType<typeof stagedPullRequestStore>
  findOpenPullRequest: () => { number: number } | null
  remoteHead: () => string | null
  /** The Developer's own `open_pull_request` (version 1's), which opens through the forge behind its body checks. */
  openWithDeveloperTool: (title: string, body: string) => ReturnType<DevToolContext['openPullRequest']>
}): V2Functions {
  return {
    runReadyGate: ({ head }) =>
      runReadyGateLive({
        worktreePath: input.worktreePath,
        branch: input.branch,
        head,
        remoteHead: input.remoteHead()
      }),
    stagedPullRequest: input.store.read,
    findOpenPullRequest: input.findOpenPullRequest,
    openPullRequest: async (staged) => {
      const opened = await input.openWithDeveloperTool(staged.title, staged.body)
      if (opened.ok) return { ok: true, pr: opened.result.prNumber }
      const error = opened.error as { message?: string; code?: string } | undefined
      return { ok: false, reason: error?.message ?? error?.code ?? JSON.stringify(opened.error) }
    },
    endStoragePushes: () => endStoragePushes(input.worktreePath)
  }
}

/** The `storage_push` Log event for one landed storage push. */
export function storagePushLogEvent(
  loopId: string,
  round: number,
  branch: string,
  head: string
): DevReviewLoopEventInput {
  return storagePushEvent({ loopId, round }, branch, head)
}
