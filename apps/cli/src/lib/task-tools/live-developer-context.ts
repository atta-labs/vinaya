import { existsSync } from 'node:fs'
import type { DevToolContext, DevToolResult } from './dev-tools-server.js'
import type { PublicationCheckInput } from '../dev-review-loop/developer-publication.js'
import { globCoversPath, isProtectedAdminPath, normalizeTouchedPath } from '@attalabs/aeg-core'
import { ProtectedPathError } from '../broker.js'
import { createDeveloperDevToolContext, type DeveloperDevToolDeps } from './developer-dev-tools-context.js'

/** The shared live context constructor used by both review-loop runners. */
export function createLiveDeveloperContext(deps: DeveloperDevToolDeps): DevToolContext {
  return createDeveloperDevToolContext(deps)
}

export type EngineLiveDeveloperContextInput = {
  branch: string
  task: number
  recordedHead: string | null
  surface: PublicationCheckInput['surface']
  git: (...args: string[]) => string
  forge: (...args: string[]) => string
  changedPaths: () => string[]
  protectedChangedPaths: () => string[]
  driverToolCall: <T>(call: () => Promise<T>) => Promise<T>
  findOpenPullRequest: () => { number: number } | null
  readPullRequestView: (
    number: number
  ) => Promise<
    DevToolResult<Awaited<ReturnType<DevToolContext['readPullRequest']>> extends DevToolResult<infer T> ? T : never>
  >
  findCredentialPatterns: (header: string, stagedDiff: string) => string[]
  validatePullRequestBody: (body: string, title?: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  refreshEvidence: (number: number) => Promise<DevToolResult<{ head: string; checksPassed: boolean; evidence: string }>>
  runChecks: () => Promise<DevToolResult<{ passed: boolean; output: string }>>
  fetchDocumentation: NonNullable<DeveloperDevToolDeps['fetchDocumentation']>
}

/** Engine binding for the same live context used by the standalone loop. */
export function createEngineLiveDeveloperContext(input: EngineLiveDeveloperContextInput): DevToolContext {
  const attempt = async <T>(check: string, run: () => T | Promise<T>): Promise<DevToolResult<T>> => {
    try {
      return { ok: true, result: await run() }
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr
      return {
        ok: false,
        error: {
          errorClass: 'internal',
          retryDisposition: 'same_attempt',
          effectState: 'not_started',
          check,
          output: stderr ? String(stderr) : error instanceof Error ? error.message : String(error),
          fix: 'Read the output, correct the cause and call the tool again.'
        }
      }
    }
  }
  const prNumber = (): number => {
    const pr = input.findOpenPullRequest()
    if (pr === null) throw new Error(`no open pull request for branch ${input.branch}`)
    return pr.number
  }
  return createLiveDeveloperContext({
    readPublicationCheckInput: () => {
      const base = input.git('merge-base', 'origin/main', 'HEAD')
      return {
        worktreeBranch: input.git('rev-parse', '--abbrev-ref', 'HEAD'),
        expectedBranch: input.branch,
        worktreeHead: input.git('rev-parse', 'HEAD'),
        recordedHead: input.recordedHead,
        base,
        expectedBase: base,
        changedPaths: input.changedPaths(),
        surface: input.surface
      }
    },
    commitAndPush: (header) =>
      input.driverToolCall(() =>
        attempt('publish_changes', () => {
          for (const path of [...input.changedPaths(), ...input.protectedChangedPaths()]) {
            const normalized = normalizeTouchedPath(path)
            if (isProtectedAdminPath(normalized) && !input.surface?.in.some((glob) => globCoversPath(glob, normalized)))
              throw new ProtectedPathError(path)
          }
          input.git('add', '-A')
          const found = input.findCredentialPatterns(header, input.git('diff', '--cached', '-U0'))
          if (found.length > 0) {
            input.git('reset', '-q')
            throw new Error(`recognized credential pattern(s): ${found.join(', ')}`)
          }
          input.git('commit', '--allow-empty-message', '-m', header)
          input.git('push', 'origin', `HEAD:refs/heads/${input.branch}`)
          return { pushedHead: input.git('rev-parse', 'HEAD') }
        })
      ),
    validatePrBody: input.validatePullRequestBody,
    openPullRequest: (title, body) =>
      attempt('open_pull_request', () => {
        input.forge('pr', 'create', '--head', input.branch, '--base', 'main', '--title', title, '--body', body)
        return { prNumber: prNumber() }
      }),
    updatePullRequestBody: (body) =>
      attempt('update_pull_request_body', () => {
        const number = prNumber()
        input.forge('pr', 'edit', String(number), '--body', body)
        return { prNumber: number }
      }),
    refreshEvidence: () => input.refreshEvidence(prNumber()),
    readPullRequest: async () => {
      const pr = input.findOpenPullRequest()
      return pr === null
        ? {
            ok: true,
            result: {
              prNumber: null,
              state: null,
              head: null,
              checks: null,
              reviews: null,
              body: null,
              failedChecks: []
            }
          }
        : input.readPullRequestView(pr.number)
    },
    runChecks: input.runChecks,
    fetchDocumentation: (request) => input.driverToolCall(() => input.fetchDocumentation(request))
  })
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
