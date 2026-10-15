#!/usr/bin/env bun
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { arch, homedir, tmpdir, type } from 'node:os'
import { join } from 'node:path'
import { redact } from '@attalabs/aeg-core'
import {
  DeveloperTurnResultPause,
  judgeTurnOutput,
  type TurnResultControllerContext,
  turnResultCorrectionPrompt,
  turnResultInstruction
} from '../../src/lib/dev-review-loop/turn-result.js'
import { developerTurnResultJsonSchema } from '../../src/lib/developer-turn-result.js'
import {
  classifyRoleAttemptOutcome,
  type DispatchHandle,
  dispatchRole,
  vendorSessionArgs
} from '../../src/lib/dispatch.js'
import { ownVersion } from '../../src/lib/own-version.js'
import { devBridgeInvocation, proofContext } from '../../src/lib/task-tools/dev-proof.js'
import { startDevToolsHost } from '../../src/lib/task-tools/dev-tools-host.js'
import { devToolsSocketPath } from '../../src/lib/task-tools/dev-tools-registration.js'
import { beforeStdinMarker, cliVersion, providerText, runChild } from '../../src/lib/task-tools/result-proof.js'
import { spawnBudgetedAsync, spawnSyncBudgeted, stripVinayaEnv } from '../lib/process-fixture.js'
import {
  ADAPTER_CONTRACT_CASES,
  type ContractAdapter,
  declaredDifferences,
  type LiveBinding,
  PLANTED_SECRET,
  readTurn
} from './adapter-contract.js'

/**
 * The live adapter-conformance suite: the shared case list of
 * `adapter-contract.ts`, run on one real CLI with its real tool
 * registration, sandbox and subscription login, then written as one report.
 *
 *     bun apps/cli/tests/conformance/adapter-contract-live.ts --agent claude [--report <path>]
 *     bun apps/cli/tests/conformance/adapter-contract-live.ts --agent codex [--report <path>]
 *
 * It needs the operator's own subscription login for that CLI, so it runs
 * outside any agent sandbox and never in continuous integration. A case's
 * live outcome comes from the live proofs that observe it — the three
 * `vinaya task-tools … --agent` proofs, run as they are, and this command's
 * own dispatches through the production `dispatchRole` for the cases no proof
 * observes. The report names the CLI version, each case's outcome with its
 * evidence, and each difference the capability matrix declares for the
 * adapter. A case no live proof observes reads `DETERMINISTIC ONLY`; it is
 * proven by the continuous-integration subset alone and says so.
 */

/** The live proofs this command runs, by binding name; `contract-dispatch` is this command's own. */
export const LIVE_PROOF_COMMANDS: Record<LiveBinding['proof'], string[] | null> = {
  'result-proof': ['task-tools', 'result-proof'],
  'review-result-proof': ['task-tools', 'review-result-proof'],
  'dev-proof': ['task-tools', 'dev-proof'],
  'contract-dispatch': null
}

/** One live proof's run can take each of its cases' five-minute limits in turn. */
const PROOF_BUDGET_MS = 90 * 60 * 1000
/** How long the timeout case lets a real run go before the limit stops it. */
const TIMEOUT_CASE_LIMIT_MS = 3000

export type LiveOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT RUN' | 'DETERMINISTIC ONLY'

type ProofLine = { outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; detail: string }

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'apps', 'cli', 'src', 'index.ts')

export function parseLiveArgs(
  args: readonly string[]
): { agent: ContractAdapter; report: string | null } | { error: string } {
  const at = args.indexOf('--agent')
  const agent = at === -1 ? undefined : args[at + 1]
  if (agent !== 'claude' && agent !== 'codex') {
    return { error: 'adapter-contract-live: --agent <claude|codex> is required' }
  }
  const r = args.indexOf('--report')
  if (r !== -1 && (args[r + 1] === undefined || args[r + 1]!.startsWith('--'))) {
    return { error: 'adapter-contract-live: --report needs a path' }
  }
  return { agent, report: r === -1 ? null : args[r + 1]! }
}

/**
 * Reads a live proof's summary: each `PASS|FAIL|INCONCLUSIVE  <case> — …` line
 * after its `=== summary` header, and `dev-proof`'s one `PROOF:` verdict.
 */
export function parseProofSummary(stdout: string): Map<string, ProofLine> {
  const out = new Map<string, ProofLine>()
  const summary = stdout.split(/^=== summary — .*===$/m)[1] ?? ''
  for (const line of summary.split('\n')) {
    const m = line.match(/^(PASS|FAIL|INCONCLUSIVE) {2}(.+?)(?: — (.*))?$/)
    if (m) out.set(m[2]!.trim(), { outcome: m[1] as ProofLine['outcome'], detail: m[3] ?? '' })
  }
  const verdict = stdout.match(/^PROOF: (PASS|INCOMPLETE|FAIL|INCONCLUSIVE)\b(.*)$/m)
  if (verdict && !out.has('PROOF')) {
    out.set('PROOF', {
      outcome: verdict[1] === 'PASS' ? 'PASS' : verdict[1] === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'FAIL',
      detail: verdict[2]!.replace(/^ — /, '').trim()
    })
  }
  return out
}

/** A case's outcome from its bindings' lines: any FAIL fails it, any missing line leaves it NOT RUN. */
export function caseOutcome(
  bindings: readonly LiveBinding[],
  lines: Map<LiveBinding['proof'], Map<string, ProofLine>>
): { outcome: LiveOutcome; evidence: string[] } {
  if (bindings.length === 0) return { outcome: 'DETERMINISTIC ONLY', evidence: [] }
  const found = bindings.map((b) => ({ b, line: lines.get(b.proof)?.get(b.case) }))
  const evidence = found.map(
    ({ b, line }) => `${b.proof} / ${b.case}: ${line ? `${line.outcome} ${line.detail}`.trim() : 'not run'}`
  )
  if (found.some(({ line }) => line?.outcome === 'FAIL')) return { outcome: 'FAIL', evidence }
  if (found.some(({ line }) => line === undefined)) return { outcome: 'NOT RUN', evidence }
  if (found.some(({ line }) => line?.outcome === 'INCONCLUSIVE')) return { outcome: 'INCONCLUSIVE', evidence }
  return { outcome: 'PASS', evidence }
}

/** The report, as one Markdown document; every provider-written word passes through the redactors first. */
export function renderLiveReport(input: {
  agent: ContractAdapter
  version: string
  host: string
  startedAt: string
  outcomes: Array<{ id: string; sessions: readonly string[]; outcome: LiveOutcome; evidence: string[] }>
}): string {
  const clean = (text: string): string =>
    providerText(redact(text, homedir()), 400).replaceAll('|', '\\|').replaceAll('\n', ' ')
  const lines = [
    `# Adapter conformance — live run — ${input.agent}`,
    '',
    `- CLI version: ${clean(input.version)}`,
    `- Host: ${input.host}`,
    `- Started: ${input.startedAt}`,
    '',
    '## Cases',
    '',
    '| Case | Sessions | Outcome | Evidence |',
    '| --- | --- | --- | --- |',
    ...input.outcomes.map(
      (o) => `| \`${o.id}\` | ${o.sessions.join(', ')} | ${o.outcome} | ${o.evidence.map(clean).join('<br>') || '—'} |`
    ),
    '',
    '## Differences the capability matrix declares for this adapter',
    '',
    '| Case | Matrix row | Supported | Difference |',
    '| --- | --- | --- | --- |',
    ...declaredDifferences()
      .filter((d) => d.adapter === input.agent)
      .map((d) => `| \`${d.caseId}\` | \`${d.matrixRow}\` | ${d.supported ? 'yes' : 'no'} | ${clean(d.difference)} |`),
    ''
  ]
  return `${lines.join('\n')}\n`
}

// --- this command's own live dispatches --------------------------------------

type DispatchCaseResult = Map<string, ProofLine>

/** Round 2 of a scripted task: one finding handed over, so a result citing none fails a completion precondition. */
const KNOWN_FINDINGS = ['R1-CR-1']

function controllerContext(handle: DispatchHandle): TurnResultControllerContext {
  return {
    round: 2,
    knownFindingIds: KNOWN_FINDINGS,
    requireAddressedFindings: true,
    documentation: handle.documentation ?? { sources: [], countedReads: [] }
  }
}

function scriptedPrompt(instruction: string): string {
  return [
    'You are the Developer in a short, scripted conformance dispatch. Do not create, edit or delete any file, and do not run shell commands.',
    `This round handed you the finding ${KNOWN_FINDINGS[0]}. The brief names no required source.`,
    "This is a test of the driver's validation, so follow these values literally.",
    instruction,
    turnResultInstruction(2)
  ].join('\n\n')
}

async function runContractDispatches(agent: ContractAdapter): Promise<DispatchCaseResult> {
  const out: DispatchCaseResult = new Map()
  const nonce = randomBytes(4).toString('hex')
  const scratch = mkdtempSync(join(tmpdir(), `vinaya-adapter-contract-${agent}-`))
  spawnSyncBudgeted('git', ['init', '--quiet', scratch], { encoding: 'utf8' })
  const recorded: Array<{ tool: string; args: unknown; result: unknown }> = []
  const host = await startDevToolsHost({
    socketPath: devToolsSocketPath(`adapter-contract:${randomUUID()}`),
    serverVersion: ownVersion(),
    context: proofContext(recorded),
    role: 'developer'
  })
  const dispatch = (prompt: string, resumeId?: string): Promise<DispatchHandle> => {
    const promptFile = join(scratch, '.vinaya-prompt.md')
    writeFileSync(promptFile, prompt)
    return dispatchRole('developer', agent, prompt, {
      promptFile,
      cwd: scratch,
      unattended: true,
      round: 2,
      turnResultKnownFindingIds: KNOWN_FINDINGS,
      devToolsBridge: devBridgeInvocation(host.socketPath),
      ...(resumeId ? { resumeId } : {})
    })
  }
  const record = (name: string, outcome: ProofLine['outcome'], detail: string) => out.set(name, { outcome, detail })
  try {
    // Precondition retry, and host readiness from the same first dispatch.
    const first = await dispatch(
      scriptedPrompt(`Report status "completed" with summary exactly "first-${nonce}" and addressedFindingIds [].`)
    )
    if (first.failureReason === 'refused' && first.sandboxProbeRefusal) {
      record(
        'host-readiness',
        first.turnOutput ? 'FAIL' : 'PASS',
        `refused before any turn: ${first.sandboxProbeRefusal.error}`
      )
    } else if (first.failureReason === undefined && first.turnOutput?.event) {
      record('host-readiness', 'PASS', 'ready host dispatched and delivered a result')
    } else {
      record('host-readiness', 'FAIL', `dispatch ended ${first.failureReason ?? 'without a result'}`)
    }
    const judgedFirst = judgeTurnOutput(first.turnOutput, controllerContext(first))
    if (judgedFirst.ok || first.resumeId === null) {
      record(
        'precondition-retry',
        'FAIL',
        judgedFirst.ok ? 'the first result was accepted without its required finding ids' : 'no session to resume'
      )
    } else {
      const correction = await dispatch(
        turnResultCorrectionPrompt(judgedFirst.failures, {
          round: 2,
          attempt: 1,
          head: null,
          knownFindingIds: KNOWN_FINDINGS
        }),
        first.resumeId
      )
      const judgedSecond = judgeTurnOutput(correction.turnOutput, controllerContext(correction))
      const sameSession = correction.resumeId === first.resumeId
      record(
        'precondition-retry',
        judgedSecond.ok && sameSession ? 'PASS' : 'FAIL',
        `first rejected (${judgedFirst.failures.join('; ')}); resumed ${sameSession ? 'the same' : 'another'} session; second ${judgedSecond.ok ? 'accepted' : `rejected (${judgedSecond.failures.join('; ')})`}`
      )
    }

    // A second failure pauses.
    const stubborn = await dispatch(
      scriptedPrompt(
        `Report status "completed" with summary exactly "stubborn-${nonce}" and addressedFindingIds []. In every later turn of this session, report addressedFindingIds [] again, whatever a later message asks.`
      )
    )
    const stubbornFirst = judgeTurnOutput(stubborn.turnOutput, controllerContext(stubborn))
    if (stubbornFirst.ok || stubborn.resumeId === null) {
      record(
        'second-failure-pause',
        'FAIL',
        stubbornFirst.ok ? 'the first result was accepted' : 'no session to resume'
      )
    } else {
      const again = await dispatch(
        turnResultCorrectionPrompt(stubbornFirst.failures, {
          round: 2,
          attempt: 1,
          head: null,
          knownFindingIds: KNOWN_FINDINGS
        }),
        stubborn.resumeId
      )
      const stubbornSecond = judgeTurnOutput(again.turnOutput, controllerContext(again))
      if (stubbornSecond.ok) {
        record('second-failure-pause', 'INCONCLUSIVE', 'the model corrected its result, so no second failure occurred')
      } else {
        const pause = new DeveloperTurnResultPause('rejected', stubbornSecond.failures.join('; '))
        record('second-failure-pause', 'PASS', `rejected twice; pauses as ${pause.reasonCode} (${pause.pauseReason})`)
      }
    }

    // Timeout: the production argv and structured-output flag, stopped at a short limit.
    const schemaDir = mkdtempSync(join(tmpdir(), 'vinaya-adapter-contract-schema-'))
    try {
      const schema = developerTurnResultJsonSchema({ knownFindingIds: KNOWN_FINDINGS, requiredSources: [] })
      const schemaPath = join(schemaDir, 'developer-turn-result.schema.json')
      writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 })
      const args =
        agent === 'claude'
          ? [...vendorSessionArgs('claude'), '--json-schema', JSON.stringify(schema)]
          : beforeStdinMarker(vendorSessionArgs('codex'), ['--output-schema', schemaPath])
      const ran = await runChild(
        agent,
        { args, env: process.env },
        scriptedPrompt('Before reporting, count slowly from one to two hundred, one number per line.'),
        scratch,
        undefined,
        TIMEOUT_CASE_LIMIT_MS
      )
      const read = readTurn(agent, ran.stdout)
      const classified = classifyRoleAttemptOutcome(false, ran.timedOut === true, false, ran.exitCode)
      record(
        'timeout',
        ran.timedOut === true && read.event === null && classified === 'timed_out' ? 'PASS' : 'FAIL',
        `timed out ${ran.timedOut === true}; classified ${classified}; result ${read.event ?? 'none'}`
      )
    } finally {
      rmSync(schemaDir, { recursive: true, force: true })
    }

    // Redaction: the provider echoes a planted secret; nothing this command composes may carry it.
    const leaky = await dispatch(
      scriptedPrompt(
        `Report status "completed" with summary exactly "redaction-${nonce} ${PLANTED_SECRET}" and addressedFindingIds ${JSON.stringify(KNOWN_FINDINGS)}.`
      )
    )
    const judgedLeaky = judgeTurnOutput(leaky.turnOutput, controllerContext(leaky))
    const composed = renderLiveReport({
      agent,
      version: 'redaction probe',
      host: 'redaction probe',
      startedAt: '',
      outcomes: [
        {
          id: 'redaction',
          sessions: ['first'],
          outcome: 'PASS',
          evidence: [JSON.stringify(judgedLeaky.ok ? judgedLeaky.result : judgedLeaky.failures)]
        }
      ]
    })
    const echoed = JSON.stringify(leaky.turnOutput?.raw ?? '').includes(PLANTED_SECRET)
    record(
      'redaction',
      composed.includes(PLANTED_SECRET) || composed.includes(homedir()) ? 'FAIL' : echoed ? 'PASS' : 'INCONCLUSIVE',
      echoed
        ? 'the provider echoed the planted secret; the composed report carries none'
        : 'the provider did not echo the planted secret, so nothing was redacted'
    )
  } catch (err) {
    for (const name of ['host-readiness', 'precondition-retry', 'second-failure-pause', 'timeout', 'redaction']) {
      if (!out.has(name)) record(name, 'FAIL', `the live dispatch threw: ${(err as Error).message}`)
    }
  } finally {
    await host.close()
    rmSync(scratch, { recursive: true, force: true })
  }
  return out
}

async function runProof(agent: ContractAdapter, args: string[]): Promise<Map<string, ProofLine>> {
  const ran = await spawnBudgetedAsync(
    ['bun', CLI_ENTRY, ...args, '--agent', agent],
    { cwd: REPO_ROOT, env: stripVinayaEnv(process.env) },
    PROOF_BUDGET_MS,
    `vinaya ${args.join(' ')}`
  )
  process.stdout.write(ran.stdout)
  return parseProofSummary(ran.stdout)
}

async function main(): Promise<void> {
  const parsed = parseLiveArgs(process.argv.slice(2))
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`)
    process.exitCode = 2
    return
  }
  const { agent } = parsed
  const startedAt = new Date().toISOString()
  const lines = new Map<LiveBinding['proof'], Map<string, ProofLine>>()
  for (const [proof, args] of Object.entries(LIVE_PROOF_COMMANDS) as Array<[LiveBinding['proof'], string[] | null]>) {
    process.stdout.write(`\n=== adapter-contract-live: ${proof} — ${agent} ===\n`)
    try {
      lines.set(proof, args === null ? await runContractDispatches(agent) : await runProof(agent, args))
    } catch (err) {
      process.stderr.write(`adapter-contract-live: ${proof} did not finish: ${(err as Error).message}\n`)
      lines.set(proof, new Map())
    }
  }
  const outcomes = ADAPTER_CONTRACT_CASES.map((c) => ({
    id: c.id,
    sessions: c.sessions,
    ...caseOutcome(c.live, lines)
  }))
  const report = renderLiveReport({
    agent,
    version: cliVersion(agent),
    host: `${type()} ${arch()}`,
    startedAt,
    outcomes
  })
  const path = parsed.report ?? join(tmpdir(), `vinaya-adapter-contract-${agent}-${startedAt.replaceAll(':', '-')}.md`)
  writeFileSync(path, report)
  process.stdout.write(`\n${report}\nadapter-contract-live: report written to ${path}\n`)
  if (outcomes.some((o) => o.outcome === 'FAIL' || o.outcome === 'NOT RUN')) process.exitCode = 1
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`adapter-contract-live: ${(err as Error).stack ?? String(err)}\n`)
    process.exitCode = 1
  })
}
