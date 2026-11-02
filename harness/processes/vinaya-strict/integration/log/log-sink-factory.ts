/**
 * The one place the product builds a Log sink: every sink — the module-level
 * default one, the loop driver's, a cancel's, each role dispatch's — is built
 * here, with the Vinaya branch-to-Issue reader (`branch-issue.ts`) as its
 * required `resolveBranchIssue` dependency. The Log client
 * (`apps/cli/src/lib/log-sink.ts`) names no task model; this module is how
 * the process's task model reaches it.
 *
 * Each entry point installs `createVinayaLogSink` as the default sink's
 * factory (`installVinayaLogSinkFactory`) before any command or run starts:
 * `apps/cli/src/index.ts` for the command line, and each runner under
 * `harness/processes/vinaya-strict/bin/`.
 */

import {
  createLogSink,
  installDefaultLogSinkFactory,
  type LogSink,
  type LogSinkDeps,
  resolveLogAppendPath
} from '../../../../../apps/cli/src/lib/log-sink.js'
import { resolveBranchIssue } from './branch-issue.js'

type BranchReadInputs = Pick<Partial<LogSinkDeps>, 'cwd' | 'env'>

/**
 * The reader bound to the SAME directory and environment every other read
 * of the sink uses (`cwd`, `env`, defaulting exactly as the sink's own do),
 * so a sink given a `cwd` of its own never reports its `meta.repo` from one
 * checkout and its branch-derived `subject.issue` from another.
 */
function branchReader(inputs: BranchReadInputs): LogSinkDeps['resolveBranchIssue'] {
  const cwd = inputs.cwd ?? (() => process.cwd())
  const env = inputs.env ?? (() => process.env)
  return (repo) => resolveBranchIssue(cwd(), env(), repo)
}

/**
 * Builds a Log sink with the Vinaya branch reader, shared across this
 * process by directory (`shareBranchIssue`) because it reads a process-wide
 * fact. A caller that gives its own `resolveBranchIssue` keeps it, and its
 * answer stays private to that sink.
 */
export function createVinayaLogSink(overrides: Partial<LogSinkDeps> = {}): LogSink {
  if (overrides.resolveBranchIssue !== undefined) {
    return createLogSink({ ...overrides, resolveBranchIssue: overrides.resolveBranchIssue })
  }
  return createLogSink({ ...overrides, resolveBranchIssue: branchReader(overrides), shareBranchIssue: true })
}

/**
 * `resolveLogAppendPath` with the same branch reader `createVinayaLogSink`
 * gives a sink, so a caller polling for its own line watches the file that
 * sink writes.
 */
export function resolveVinayaLogAppendPath(
  repo: { owner: string; repo: string } | null,
  issue: number | null,
  overrides: Partial<
    Pick<LogSinkDeps, 'resolveLogDestination' | 'outboxRoot' | 'env' | 'cwd' | 'resolveBranchIssue'>
  > = {}
): Promise<string> {
  if (overrides.resolveBranchIssue !== undefined) {
    return resolveLogAppendPath(repo, issue, { ...overrides, resolveBranchIssue: overrides.resolveBranchIssue })
  }
  return resolveLogAppendPath(repo, issue, {
    ...overrides,
    resolveBranchIssue: branchReader(overrides),
    shareBranchIssue: true
  })
}

/** Installs `createVinayaLogSink` as the factory the Log client's default sink is built from. */
export function installVinayaLogSinkFactory(): void {
  installDefaultLogSinkFactory(createVinayaLogSink)
}
