/**
 * `vinaya task-tools result-proof --agent <claude|codex>` — the live proof that
 * each CLI delivers the Developer's turn result (`developer-turn-result.ts`) as
 * its own native structured final output, committed as a repeatable command
 * beside `dev-proof.ts`, whose dispatch shape it reuses.
 *
 * Every case is a real Developer-shaped dispatch on this host: the driver-run
 * dev-tools server registered exactly as a dispatch registers it (the whole
 * production catalog, every write tool refusing here), the agent's own sandbox
 * where the host supports it, the subscription login, and the vendor argv the
 * dispatch itself builds (`vendorSessionArgs`/`vendorResumeArgs`) plus the one
 * structured-output flag under test:
 *
 *  - Claude Code: `--json-schema <schema>` under `--output-format stream-json`,
 *    with the dispatch's own settings file;
 *  - Codex: `--output-schema <file>` under `exec --json` and `exec resume --json`.
 *
 * The result is read by the production adapter readers and judged by the
 * production controller (`dev-review-loop/turn-result.ts`) — no Stop hook
 * takes part in accepting, rejecting or selecting it.
 *
 * The cases: a first session and a resumed one (same provider session, a fresh
 * result, exactly one accepted); a first result that misses a required source,
 * which the controller rejects before resuming the same session once with the
 * typed failures, accepting only the second, valid result; a schema-valid but
 * semantically invalid result of each kind (an unknown finding id, a ruling
 * request naming no permissible decision), which the driver must reject;
 * malformed model output, which must never reach the driver; and a cancelled
 * run, a provider error and context exhaustion, each of which must end with no
 * accepted result.
 *
 * For every case it prints whether a schema-valid result reached the driver,
 * the result, and the event it was read from. It never publishes, opens a pull
 * request or writes the forge, and it designs no fallback: a failing case is
 * reported as observed.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { ownVersion } from '../artifacts.js'
import {
  DEVELOPER_TURN_RESULT_SCHEMA_VERSION,
  type DeveloperTurnContext,
  type DeveloperTurnResult,
  developerTurnResultJsonSchema,
  parseDeveloperTurnResult
} from '../developer-turn-result.js'
import {
  judgeTurnOutput,
  PERMISSIBLE_RULING_DECISIONS,
  readClaudeTurnOutput,
  readCodexTurnOutput,
  type TurnRead,
  turnResultCorrectionPrompt
} from '../dev-review-loop/turn-result.js'
import { vendorResumeArgs, vendorSessionArgs, writeDispatchSettingsAt } from '../dispatch.js'
import { buildWorkerEnv, realConfinementPlatformDeps, resolveClaudeConfinement } from '../worker-boundary.js'
import {
  type ConfinementDisclosure,
  confinedTmpEnv,
  devBridgeInvocation,
  proofContext,
  resolveProofConfinement,
  stageProofCodexHome
} from './dev-proof.js'
import { startDevToolsHost } from './dev-tools-host.js'
import { DEV_TOOLS_MCP_SERVER_NAME } from './dev-tools-names.js'
import {
  type BridgeInvocation,
  claudeDevToolName,
  claudeDevToolsArgs,
  devToolsMcpConfigFileBody,
  devToolsSocketPath
} from './dev-tools-registration.js'

export type ResultProofAgent = 'claude' | 'codex'

/** Parses `--agent <claude|codex>` out of the command's argv. */
export function parseResultProofArgs(args: readonly string[]): { agent: ResultProofAgent } | { error: string } {
  const idx = args.indexOf('--agent')
  if (idx === -1 || idx === args.length - 1) {
    return { error: 'vinaya task-tools result-proof: missing required --agent <claude|codex>' }
  }
  const agent = args[idx + 1]
  if (agent !== 'claude' && agent !== 'codex') {
    return {
      error: `vinaya task-tools result-proof: --agent must be 'claude' or 'codex', got ${JSON.stringify(agent)}`
    }
  }
  return { agent }
}

/** The tool every first and resumed session calls to prove the real MCP path — read-only, stamped by the driver. */
const PROOF_TOOL = 'run_checks'

/** The turn the proof sessions are told they are in: two findings, one required source, two permissible decisions. */
export const PROOF_TURN_CONTEXT: DeveloperTurnContext = {
  knownFindingIds: ['R1-CR-1', 'R1-SEC-1'],
  requiredSources: ['https://code.claude.com/docs/en/cli-reference'],
  permissibleDecisions: PERMISSIBLE_RULING_DECISIONS
}

/** The adapter readers are the production ones, shared with every Developer dispatch. */
export { readClaudeTurnOutput, readCodexTurnOutput, type TurnRead }

/**
 * The adapter boundary: a value reaches the driver only when it matches the
 * schema the provider was given — anything else is refused here and never
 * crosses. What crosses is then judged semantically by the driver.
 */
export type DriverVerdict =
  | { crossed: false; reason: string }
  | { crossed: true; result: DeveloperTurnResult; accepted: true }
  | { crossed: true; result: DeveloperTurnResult; accepted: false; errors: string[] }

export function driverVerdict(read: TurnRead, context: DeveloperTurnContext): DriverVerdict {
  if (read.event === null) return { crossed: false, reason: 'the stream carried no structured result' }
  const shaped = parseDeveloperTurnResult(read.raw, context)
  if (!shaped.ok) return { crossed: false, reason: `refused at the adapter (schema): ${shaped.errors.join('; ')}` }
  // The production controller judges it: a round past the first (the proof's
  // findings come from a review), and the proof's required source declared
  // read — the proof sessions fetch nothing, so it supplies the receipt.
  const judged = judgeTurnOutput(
    { adapter: 'claude --json-schema', raw: read.raw, event: read.event },
    {
      round: 2,
      knownFindingIds: context.knownFindingIds,
      requireAddressedFindings: false,
      documentation: { sources: context.requiredSources, countedReads: context.requiredSources }
    }
  )
  return judged.ok
    ? { crossed: true, result: shaped.result, accepted: true }
    : { crossed: true, result: shaped.result, accepted: false, errors: judged.failures }
}

/** What a case requires of its outcome. */
export type CaseExpectation =
  /** A schema-valid result reached the driver and was accepted; `summary` pins which emission it was. */
  | { kind: 'accepted'; summary: string; resumes?: 'first' }
  /** A schema-valid result reached the driver and its semantic check refused it. */
  | { kind: 'rejected'; error: string }
  /**
   * The controller rejects the first result for `error`, the proof resumes the
   * SAME session once with the typed failures, and only that second result is
   * accepted.
   */
  | { kind: 'rejected-then-accepted'; error: string }
  /** Nothing malformed crossed: either the provider repaired it into a valid result, or no result arrived. */
  | { kind: 'never-malformed' }
  /** The invocation ended with no accepted result. */
  | { kind: 'none' }

/** Judges one case's outcome against its expectation; the lines say why. */
export function judgeCase(
  expectation: CaseExpectation,
  read: TurnRead,
  verdict: DriverVerdict,
  extra: { firstSessionId?: string | null; firstSummary?: string | null; firstVerdict?: DriverVerdict } = {}
): { pass: boolean; why: string[] } {
  const why: string[] = []
  let pass = true
  const fail = (line: string): void => {
    pass = false
    why.push(`FAIL: ${line}`)
  }
  if (expectation.kind === 'accepted') {
    if (!verdict.crossed || !verdict.accepted) fail('no accepted result')
    else if (verdict.result.summary !== expectation.summary) {
      fail(`accepted summary ${JSON.stringify(verdict.result.summary)} is not ${JSON.stringify(expectation.summary)}`)
    } else why.push(`accepted result is the expected emission (summary ${JSON.stringify(expectation.summary)})`)
    if (read.terminalResults !== 1) fail(`${read.terminalResults} terminal results — exactly one must be accepted`)
    else why.push('exactly one result accepted')
    if (expectation.resumes === 'first') {
      if (!read.sessionId || read.sessionId !== extra.firstSessionId) {
        fail(`resumed session ${read.sessionId} is not the first session ${extra.firstSessionId}`)
      } else why.push(`same provider session resumed (${read.sessionId})`)
      if (verdict.crossed && verdict.result.summary === extra.firstSummary) {
        fail('the resumed invocation returned the earlier turn result')
      } else why.push('no earlier turn result reused')
    }
  }
  if (expectation.kind === 'rejected') {
    if (!verdict.crossed) fail(`no schema-valid result reached the driver (${verdict.reason})`)
    else if (verdict.accepted) fail('the driver accepted a semantically invalid result')
    else if (!verdict.errors.some((e) => e.includes(expectation.error))) {
      fail(`rejected, but not for ${JSON.stringify(expectation.error)}: ${verdict.errors.join('; ')}`)
    } else why.push(`driver rejected it: ${verdict.errors.join('; ')}`)
  }
  if (expectation.kind === 'rejected-then-accepted') {
    const first = extra.firstVerdict
    if (!first?.crossed) fail('the first result never reached the controller')
    else if (first.accepted) fail('the controller accepted the first result, which misses a required source')
    else if (!first.errors.some((e) => e.includes(expectation.error))) {
      fail(
        `the first result was rejected, but not for ${JSON.stringify(expectation.error)}: ${first.errors.join('; ')}`
      )
    } else why.push(`the controller rejected the first result: ${first.errors.join('; ')}`)
    if (!read.sessionId || read.sessionId !== extra.firstSessionId) {
      fail(`the correction ran in session ${read.sessionId}, not the first result's session ${extra.firstSessionId}`)
    } else why.push(`same provider session resumed (${read.sessionId})`)
    if (!verdict.crossed || !verdict.accepted) {
      fail(
        `the second result was not accepted${verdict.crossed && !verdict.accepted ? `: ${verdict.errors.join('; ')}` : ''}`
      )
    } else why.push('only the second, valid result was accepted')
    if (read.terminalResults !== 1)
      fail(`${read.terminalResults} terminal results on the correction — exactly one must be accepted`)
  }
  if (expectation.kind === 'never-malformed') {
    if (verdict.crossed) why.push('the provider repaired the output into a schema-valid result before it ended')
    else why.push(`no result crossed the adapter (${verdict.reason})`)
  }
  if (expectation.kind === 'none') {
    if (verdict.crossed && verdict.accepted) fail('a result was accepted')
    else why.push(verdict.crossed ? 'a result arrived but was not accepted' : `no accepted result (${verdict.reason})`)
  }
  return { pass, why }
}

/** One live invocation the proof runs. */
type ProofCase = {
  name: string
  objectives: string
  prompt: string
  expectation: CaseExpectation
  /** Resume the first case's provider session rather than starting a new one. */
  resume?: boolean
  model?: string
  /** Kill the child this long after its first stdout line. */
  cancelAfterMs?: number
  /** Resume this case's own session once with the controller's typed failures, and judge that second result. */
  correctOnce?: boolean
  /** The invalid value the per-turn schema must reject; checked without the agent, while the prompt asks for the valid one. */
  schemaRejects?: SchemaInvalid
}

/** The two values the per-turn schema forbids, which the live cases no longer ask the agent to report. */
export type SchemaInvalid = 'missing-source' | 'unknown-finding-id'

/** The one time limit every proof case runs under. */
export const CASE_TIME_LIMIT_MS = 5 * 60 * 1000
export const CASE_TIME_LIMIT_LABEL = `${CASE_TIME_LIMIT_MS / 60_000} minutes`

function toolInstruction(agent: ResultProofAgent): string {
  return agent === 'claude'
    ? `Call the \`${claudeDevToolName(PROOF_TOOL)}\` tool once, with no arguments.`
    : `Call the MCP tool named \`${PROOF_TOOL}\`, provided by the MCP server \`${DEV_TOOLS_MCP_SERVER_NAME}\`, once, with an empty JSON object as its arguments.`
}

function turnPreamble(): string {
  const c = PROOF_TURN_CONTEXT
  return [
    'You are the Developer in a short, scripted proof dispatch. Do not create, edit or delete any file, and do not run shell commands.',
    `This round handed you the findings ${c.knownFindingIds.join(' and ')}. The brief's one required source is ${c.requiredSources[0]}.`,
    `End your turn with your turn result as your structured output, using schemaVersion ${DEVELOPER_TURN_RESULT_SCHEMA_VERSION}.`
  ].join('\n')
}

function completedInstruction(summary: string, findingIds: readonly string[]): string {
  const source = PROOF_TURN_CONTEXT.requiredSources[0]
  return (
    `Report status "completed" with summary exactly "${summary}", confidence 90, a one-sentence confidenceExplanation, ` +
    `addressedFindingIds ${JSON.stringify(findingIds)}, sourceUses with one entry whose source is "${source}" and whose use is one sentence, ` +
    `and reportedChecks with one entry {"command": "${PROOF_TOOL}", "outcome": "pass"}.`
  )
}

/** The per-turn schema object the proof hands each agent — the one the schema check validates against. */
export function proofTurnSchema(): Record<string, unknown> {
  return developerTurnResultJsonSchema(PROOF_TURN_CONTEXT)
}

/** A compact Draft-7 validator for the subset emitted by z.toJSONSchema. */
export function validatesJsonSchema(schema: unknown, value: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return true
  const node = schema as Record<string, unknown>
  if (Array.isArray(node.anyOf)) return node.anyOf.some((variant) => validatesJsonSchema(variant, value))
  if ('const' in node && value !== node.const) return false
  if (Array.isArray(node.enum) && !node.enum.includes(value)) return false
  if (node.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const object = value as Record<string, unknown>
    const properties = (node.properties ?? {}) as Record<string, unknown>
    if (Array.isArray(node.required) && node.required.some((key) => typeof key !== 'string' || !(key in object)))
      return false
    if (node.additionalProperties === false && Object.keys(object).some((key) => !(key in properties))) return false
    return Object.entries(properties).every(
      ([key, property]) => !(key in object) || validatesJsonSchema(property, object[key])
    )
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) return false
    if (typeof node.minItems === 'number' && value.length < node.minItems) return false
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) return false
    return value.every((item) => validatesJsonSchema(node.items, item))
  }
  if (node.type === 'string') {
    if (typeof value !== 'string') return false
    return !(
      (typeof node.minLength === 'number' && value.length < node.minLength) ||
      (typeof node.maxLength === 'number' && value.length > node.maxLength)
    )
  }
  if (node.type === 'number' || node.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (node.type === 'integer' && !Number.isInteger(value)))
      return false
    return !(
      (typeof node.minimum === 'number' && value < node.minimum) ||
      (typeof node.maximum === 'number' && value > node.maximum)
    )
  }
  return true
}

/** A completed turn result carrying the valid values, and the same one carrying the invalid value. */
function schemaCheckValues(invalid: SchemaInvalid): { valid: unknown; invalidValue: unknown } {
  const validTurn = {
    schemaVersion: DEVELOPER_TURN_RESULT_SCHEMA_VERSION,
    status: 'completed',
    summary: 'schema check',
    confidence: 90,
    confidenceExplanation: 'the schema check',
    addressedFindingIds: [PROOF_TURN_CONTEXT.knownFindingIds[0]],
    sourceUses: [{ source: PROOF_TURN_CONTEXT.requiredSources[0], use: 'schema check' }],
    reportedChecks: null
  }
  const invalidTurn =
    invalid === 'missing-source'
      ? { ...validTurn, sourceUses: null }
      : { ...validTurn, addressedFindingIds: ['R9-XX-404'] }
  return { valid: { turnResult: validTurn }, invalidValue: { turnResult: invalidTurn } }
}

/** Checks, without the agent, that `schema` rejects the invalid value and accepts the valid one. */
export function checkSchemaRejects(schema: unknown, invalid: SchemaInvalid): { pass: boolean; why: string[] } {
  const { valid, invalidValue } = schemaCheckValues(invalid)
  const label =
    invalid === 'missing-source'
      ? 'a result that omits the required source'
      : 'a result naming an id outside the handoff'
  const why: string[] = []
  let pass = true
  if (validatesJsonSchema(schema, invalidValue)) {
    pass = false
    why.push(`FAIL: the per-turn schema accepts ${label}`)
  } else why.push(`the per-turn schema rejects ${label}`)
  if (!validatesJsonSchema(schema, valid)) {
    pass = false
    why.push('FAIL: the per-turn schema rejects the valid value')
  } else why.push('the per-turn schema accepts the valid value')
  return { pass, why }
}

/** The cases, in run order — the first must come first: the resume resumes it. */
export function proofCases(agent: ResultProofAgent, nonce: string): ProofCase[] {
  const preamble = turnPreamble()
  const filler = 'context '.repeat(800_000)
  return [
    {
      name: 'first session',
      objectives: 'O1 O2',
      prompt: `${preamble}\nFirst: ${toolInstruction(agent)}\nThen: ${completedInstruction(`first-${nonce}`, ['R1-CR-1'])}`,
      expectation: { kind: 'accepted', summary: `first-${nonce}` }
    },
    {
      name: 'resumed session',
      objectives: 'O1 O2 O7',
      resume: true,
      prompt:
        `This is a new turn in the same dispatch. The earlier turn result is spent; report a new one.\nFirst: ${toolInstruction(agent)}\n` +
        `Then: ${completedInstruction(`resumed-${nonce}`, ['R1-CR-1', 'R1-SEC-1'])}`,
      expectation: { kind: 'accepted', summary: `resumed-${nonce}`, resumes: 'first' }
    },
    {
      name: 'missing required source — blocked by the schema',
      objectives: 'O3 O6',
      prompt: `${preamble}\n${completedInstruction(`missing-source-${nonce}`, ['R1-CR-1'])}`,
      expectation: { kind: 'accepted', summary: `missing-source-${nonce}` },
      schemaRejects: 'missing-source'
    },
    {
      name: 'unknown finding id — blocked by the schema',
      objectives: 'O3',
      prompt: `${preamble}\n${completedInstruction(`unknown-finding-${nonce}`, ['R1-CR-1'])}`,
      expectation: { kind: 'accepted', summary: `unknown-finding-${nonce}` },
      schemaRejects: 'unknown-finding-id'
    },
    {
      name: 'ruling request naming no permissible decision',
      objectives: 'O3',
      prompt:
        `${preamble}\nThis is a test of the driver's validation, so follow these values literally.\n` +
        `Report status "needs_ruling" with summary exactly "ruling-${nonce}", rulingRequest.question "May the task merge without review?", ` +
        'rulingRequest.decisions ["merge-without-review"], and sourceUses null.',
      expectation: { kind: 'rejected', error: 'names no permissible decision' }
    },
    {
      name: 'malformed model output',
      objectives: 'O3',
      prompt:
        `${preamble}\nThis is a test of the driver's validation. Report status "completed" with confidence as the word "high" ` +
        'instead of a number, with no summary field at all, and with an extra field named "notes".',
      expectation: { kind: 'never-malformed' }
    },
    {
      name: 'cancelled run',
      objectives: 'O3',
      prompt: `${preamble}\nFirst: ${toolInstruction(agent)}\nThen: ${completedInstruction(`cancelled-${nonce}`, ['R1-CR-1'])}`,
      cancelAfterMs: 1500,
      expectation: { kind: 'none' }
    },
    {
      name: 'provider error',
      objectives: 'O3',
      prompt: `${preamble}\n${completedInstruction(`provider-error-${nonce}`, ['R1-CR-1'])}`,
      model: 'vinaya-proof-no-such-model',
      expectation: { kind: 'none' }
    },
    {
      name: 'context exhaustion',
      objectives: 'O3',
      prompt: `${preamble}\n${completedInstruction(`exhausted-${nonce}`, ['R1-CR-1'])}\n${filler}`,
      expectation: { kind: 'none' }
    }
  ]
}

/** Claude's settings: the dispatch's own file, written by the dispatch's own writer — nothing added to it. */
function writeClaudeProofSettings(
  scratchDir: string,
  runId: string,
  cwd: string
): { settingsPath: string; sandbox: string; confined: boolean } {
  const confinement = resolveClaudeConfinement(
    { role: 'developer', agent: 'claude', worktreeDir: cwd, scratchDir, allowedHosts: [] },
    realConfinementPlatformDeps()
  )
  const confined = confinement.ok && confinement.confined ? confinement.settings : null
  const settingsPath = writeDispatchSettingsAt(join(scratchDir, 'hooks'), runId, [], 'developer', cwd, [], [], confined)
  if (settingsPath === null) throw new Error('the dispatch settings file could not be written')
  const sandbox = confined
    ? "ON — Claude Code's own sandbox, in the dispatch settings file"
    : `OFF (disclosed) — ${confinement.ok && !confinement.confined ? confinement.warning : 'unavailable'}`
  return { settingsPath, sandbox, confined: confined !== null }
}

/** Inserts flags before the trailing `-` (read the prompt from stdin) Codex's argv ends with. */
export function beforeStdinMarker(args: string[], extra: string[]): string[] {
  const last = args[args.length - 1]
  return last === '-' ? [...args.slice(0, -1), ...extra, '-'] : [...args, ...extra]
}

export type Launch = { args: string[]; env: NodeJS.ProcessEnv }

/**
 * `USER`/`LOGNAME` for the child, from the parent when it has them and from
 * the OS account when it does not. A dispatch inherits both from the driver,
 * and Claude Code's Keychain lookup needs both (`WORKER_ENV_ALLOWLIST_KEYS`),
 * but a parent that narrowed its own environment — the PR-report runner that
 * executes a Test Plan line passes neither — would otherwise turn every Claude
 * case into "Not logged in". Account names, not secrets.
 */
export function accountEnv(source: NodeJS.ProcessEnv, username: () => string): Record<string, string> {
  const fallback = source.USER ?? source.LOGNAME ?? username()
  return { USER: source.USER ?? fallback, LOGNAME: source.LOGNAME ?? fallback }
}

type LaunchPlan = {
  sandbox: string
  launch: (resumeId: string | null, model: string | undefined) => Launch
}

function planLaunches(agent: ResultProofAgent, bridge: BridgeInvocation, scratchDir: string, cwd: string): LaunchPlan {
  const runId = randomUUID()
  if (agent === 'claude') {
    const mcpConfigPath = join(scratchDir, 'dev-tools.mcp.json')
    writeFileSync(mcpConfigPath, devToolsMcpConfigFileBody(bridge), { mode: 0o600 })
    const { settingsPath, sandbox, confined } = writeClaudeProofSettings(scratchDir, runId, cwd)
    const schema = JSON.stringify(proofTurnSchema())
    return {
      sandbox,
      launch: (resumeId, model) => ({
        args: [
          ...(resumeId ? vendorResumeArgs('claude', resumeId, model) : vendorSessionArgs('claude', model)),
          ...claudeDevToolsArgs(mcpConfigPath),
          '--settings',
          settingsPath,
          '--json-schema',
          schema
        ],
        env: buildWorkerEnv(process.env, {
          ...accountEnv(process.env, () => userInfo().username),
          VINAYA_RUN_ID: runId,
          ...confinedTmpEnv(confined, scratchDir)
        })
      })
    }
  }
  const confinement: ConfinementDisclosure = resolveProofConfinement('codex', 'developer', cwd, scratchDir)
  const codexHome = stageProofCodexHome(bridge, scratchDir, confinement)
  const schemaPath = join(scratchDir, 'developer-turn-result.schema.json')
  writeFileSync(schemaPath, `${JSON.stringify(proofTurnSchema(), null, 2)}\n`)
  return {
    sandbox: confinement.confined ? `ON — ${confinement.detail}` : `OFF (disclosed) — ${confinement.detail}`,
    launch: (resumeId, model) => ({
      args: beforeStdinMarker(
        resumeId ? vendorResumeArgs('codex', resumeId, model) : vendorSessionArgs('codex', model),
        ['--output-schema', schemaPath]
      ),
      env: buildWorkerEnv(process.env, {
        ...accountEnv(process.env, () => userInfo().username),
        CODEX_HOME: codexHome,
        VINAYA_RUN_ID: runId,
        ...confinedTmpEnv(confinement.confined, scratchDir)
      })
    })
  }
}

export type RunOutcome = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  spawnError?: string
  /** The caller's own `cancelAfterMs` kill was sent while the child was still running — whatever exit code or signal followed. */
  cancelled?: boolean
  /** The `timeoutMs` limit was reached and the child's process group was killed. */
  timedOut?: boolean
}

export function runChild(
  command: string,
  launch: Launch,
  prompt: string,
  cwd: string,
  cancelAfterMs: number | undefined,
  timeoutMs?: number
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    // With a time limit the child leads its own process group, so the limit stops its children with it;
    // without one it stays in the caller's group and a terminal Ctrl+C reaches it as before.
    const grouped = timeoutMs !== undefined
    const child = spawn(command, launch.args, {
      cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: grouped
    })
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    // A grouped child no longer receives the terminal's Ctrl+C, so the parent's abort or exit stops its group.
    const onSignal = (): void => process.exit(130)
    if (grouped) {
      process.once('exit', killGroup)
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
    }
    const release = (): void => {
      if (!grouped) return
      process.removeListener('exit', killGroup)
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
    let timedOut = false
    const limit =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => {
              timedOut = true
              killGroup()
              release()
              // a grandchild that escaped the group may hold the pipes open: do not wait for them
              resolve({ exitCode: null, signal: 'SIGKILL', stdout, stderr, timedOut: true })
            },
            Math.max(0, timeoutMs)
          )
    let stdout = ''
    let stderr = ''
    let cancelArmed = false
    let cancelled = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (cancelAfterMs !== undefined && !cancelArmed) {
        cancelArmed = true
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) cancelled = child.kill('SIGTERM')
        }, cancelAfterMs)
      }
    })
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (err) => {
      clearTimeout(limit)
      release()
      resolve({ exitCode: null, signal: null, stdout, stderr, spawnError: err.message })
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(limit)
      release()
      resolve({ exitCode, signal, stdout, stderr, cancelled, ...(timedOut ? { timedOut } : {}) })
    })
    child.stdin.on('error', () => {
      // a child that exits before reading its whole prompt closes the pipe — the outcome still reports it
    })
    child.stdin.end(prompt)
  })
}

export function cliVersion(command: string): string {
  const out = spawnSync(command, ['--version'], { encoding: 'utf8' })
  const text = `${out.stdout ?? ''}`.trim()
  return text.length > 0 ? text : `unavailable (${out.error?.message ?? (out.stderr ?? '').trim()})`
}

export function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text
}

/** One POSIX shell word: single-quoted, with any single quote closed, escaped and reopened, so no character in `value` is interpreted. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Provider-written text (stream errors, stderr) is printed for pasting into a
 * public pull request, so the home directory becomes `~` and anything shaped
 * like an email address becomes `<email>` before it is shown.
 */
export function redactProviderText(text: string, home: string = homedir()): string {
  const withoutHome = home.length > 1 ? text.replaceAll(home, '~') : text
  return withoutHome.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
}

/** `clip` after `redactProviderText` — the one form provider text is printed in. */
export function providerText(text: string, max?: number): string {
  return clip(redactProviderText(text), max)
}

/** Runs the cases in order, each under the one time limit; a case that reaches it is FAIL and the next case still runs. */
export async function runProofCases(opts: {
  agent: ResultProofAgent
  command: string
  cases: ProofCase[]
  plan: Pick<LaunchPlan, 'launch'>
  recorded: unknown[]
  cwd: string
  out: (line?: string) => void
  limitMs?: number
}): Promise<{ allPass: boolean; summaries: string[] }> {
  const { agent, command, plan, recorded, cwd, out } = opts
  const limitMs = opts.limitMs ?? CASE_TIME_LIMIT_MS
  let allPass = true
  let firstSessionId: string | null = null
  let firstSummary: string | null = null
  const summaries: string[] = []
  for (const proofCase of opts.cases) {
    out(`\n--- case: ${proofCase.name} (${proofCase.objectives}) ---`)
    if (proofCase.resume && firstSessionId === null) {
      out('FAIL: no first session id to resume')
      allPass = false
      summaries.push(`FAIL  ${proofCase.name}`)
      continue
    }
    const callsBefore = recorded.length
    const deadline = Date.now() + limitMs
    let timedOut = false
    const invoke = async (
      resumeId: string | null,
      prompt: string
    ): Promise<{ ran: RunOutcome; read: TurnRead; verdict: DriverVerdict; stderrTail: string } | null> => {
      const launch = plan.launch(resumeId, proofCase.model)
      const shownArgs = launch.args.map((a) => (a.startsWith('{') ? '<schema>' : a))
      out(`invocation: ${agent} ${shownArgs.join(' ')}`)
      const ran = await runChild(
        command,
        launch,
        prompt,
        cwd,
        proofCase.cancelAfterMs,
        Math.max(0, deadline - Date.now())
      )
      if (ran.timedOut) {
        out(`FAIL: ${proofCase.name} timed out after ${CASE_TIME_LIMIT_LABEL}`)
        timedOut = true
        return null
      }
      if (ran.spawnError) {
        out(`FAIL: could not spawn ${agent}: ${ran.spawnError}`)
        return null
      }
      const read = agent === 'claude' ? readClaudeTurnOutput(ran.stdout) : readCodexTurnOutput(ran.stdout)
      const verdict = driverVerdict(read, PROOF_TURN_CONTEXT)
      out(
        `exit: code ${ran.exitCode}${ran.signal ? `, signal ${ran.signal}` : ''}; terminal event: ${read.terminal ?? '(none)'}`
      )
      out(`provider session: ${read.sessionId ?? '(none reported)'}`)
      out(`structured emissions seen: ${read.emissions.length}`)
      for (const emission of read.emissions) out(`  ${clip(JSON.stringify(emission))}`)
      if (read.errors.length > 0) out(`stream errors: ${providerText(read.errors.join(' | '))}`)
      const stderrTail = ran.stderr.trim().split('\n').slice(-3).join(' | ')
      if (stderrTail.length > 0) out(`stderr tail: ${providerText(stderrTail)}`)
      out(`event read: ${read.event ?? '(none)'}`)
      out(`schema-valid result reached the driver: ${verdict.crossed ? 'yes' : 'no'}`)
      if (verdict.crossed) {
        out(`controller validation: ${verdict.accepted ? 'accepted' : `rejected — ${verdict.errors.join('; ')}`}`)
        out(`result: ${JSON.stringify(verdict.result)}`)
      } else {
        out(`controller validation: nothing to validate — ${verdict.reason}`)
      }
      return { ran, read, verdict, stderrTail }
    }
    let outcome = await invoke(proofCase.resume ? firstSessionId : null, proofCase.prompt)
    if (outcome === null) {
      allPass = false
      summaries.push(`FAIL  ${proofCase.name}${timedOut ? ` — timed out after ${CASE_TIME_LIMIT_LABEL}` : ''}`)
      continue
    }
    // O6: the controller-rejection case — a first result the controller
    // refused is answered by resuming the SAME session once with only the
    // typed failures (the production correction prompt), and only that
    // second result may be accepted.
    let firstOfCase: { sessionId: string | null; verdict: DriverVerdict } | null = null
    if (proofCase.correctOnce) {
      const firstVerdict = outcome.verdict
      firstOfCase = { sessionId: outcome.read.sessionId, verdict: firstVerdict }
      const failures = firstVerdict.crossed && !firstVerdict.accepted ? firstVerdict.errors : []
      if (outcome.read.sessionId !== null && failures.length > 0) {
        out('correction: resuming the same session once with the typed failures')
        const corrected = await invoke(
          outcome.read.sessionId,
          turnResultCorrectionPrompt(failures, {
            round: 2,
            attempt: 1,
            head: null,
            knownFindingIds: PROOF_TURN_CONTEXT.knownFindingIds
          })
        )
        if (corrected === null) {
          allPass = false
          summaries.push(`FAIL  ${proofCase.name}${timedOut ? ` — timed out after ${CASE_TIME_LIMIT_LABEL}` : ''}`)
          continue
        }
        outcome = corrected
      } else out('correction: not run — the first result was not rejected')
    }
    const { read, verdict, stderrTail } = outcome
    out(`dev-tools calls received by the driver: ${recorded.length - callsBefore}`)
    const judged = judgeCase(
      proofCase.expectation,
      read,
      verdict,
      firstOfCase
        ? { firstSessionId: firstOfCase.sessionId, firstVerdict: firstOfCase.verdict }
        : { firstSessionId, firstSummary }
    )
    if (proofCase.name === 'first session') {
      firstSessionId = read.sessionId
      firstSummary = verdict.crossed ? verdict.result.summary : null
      if (recorded.length - callsBefore < 1) {
        judged.pass = false
        judged.why.push('FAIL: the session made no dev-tools call')
      }
    }
    if (proofCase.resume && recorded.length - callsBefore < 1) {
      judged.pass = false
      judged.why.push('FAIL: the resumed session made no dev-tools call')
    }
    if (proofCase.schemaRejects) {
      const checked = checkSchemaRejects(proofTurnSchema(), proofCase.schemaRejects)
      if (!checked.pass) judged.pass = false
      judged.why.push(...checked.why)
    }
    for (const line of judged.why) out(`  ${line}`)
    out(`verdict: ${judged.pass ? 'PASS' : 'FAIL'}`)
    if (!judged.pass) allPass = false
    // The summary repeats each case's deciding facts on one line, so a reader
    // that keeps only the tail of this output still sees why a case failed.
    const failures = judged.why.filter((line) => line.startsWith('FAIL: '))
    const emitted = read.emissions.map((e) => emissionSummary(e)).join(',')
    summaries.push(
      `${judged.pass ? 'PASS' : 'FAIL'}  ${proofCase.name} — terminal ${read.terminal ?? '(none)'}; emissions [${emitted}]; ` +
        `accepted ${verdict.crossed && verdict.accepted ? JSON.stringify(verdict.result.summary) : 'none'}` +
        (failures.length > 0 ? `; ${clip(failures.join(' / '), 300)}` : '') +
        (!verdict.crossed && read.event === null && read.errors.length > 0
          ? `; errors: ${providerText(read.errors.join(' | '), 200)}`
          : '') +
        (read.event === null && stderrTail.length > 0 ? `; stderr: ${providerText(stderrTail, 200)}` : '')
    )
  }
  return { allPass, summaries }
}

/** The command entry point: run every case for one agent and print the report. */
export async function resultProofCommand(args: string[]): Promise<void> {
  const parsed = parseResultProofArgs(args)
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`)
    process.exitCode = 2
    return
  }
  const { agent } = parsed
  const cwd = process.cwd()
  const nonce = randomBytes(4).toString('hex')
  const scratchDir = mkdtempSync(join(tmpdir(), `vinaya-result-proof-${agent}-`))
  const recorded: { tool: string; args: unknown; result: unknown }[] = []
  const host = await startDevToolsHost({
    socketPath: devToolsSocketPath(`result-proof:${randomUUID()}`),
    serverVersion: ownVersion(),
    context: proofContext(recorded)
  })
  const out = (line = ''): void => {
    process.stdout.write(`${line}\n`)
  }
  let allPass = true
  try {
    const bridge = devBridgeInvocation(host.socketPath)
    const plan = planLaunches(agent, bridge, scratchDir, cwd)
    out(`\n=== Developer turn result — native structured output proof — agent: ${agent} ===`)
    out(`host: ${process.platform} ${process.arch}`)
    out(`CLI version: ${cliVersion(agent)}`)
    out(
      `schema: DeveloperTurnResult v${DEVELOPER_TURN_RESULT_SCHEMA_VERSION} via ${agent === 'claude' ? '--json-schema' : '--output-schema'}`
    )
    out(`sandbox: ${plan.sandbox}`)
    out(
      `dev-tools: ${DEV_TOOLS_MCP_SERVER_NAME} hosted by driver pid ${process.pid}, full catalog registered, write tools refuse`
    )
    out(`turn context: ${JSON.stringify(PROOF_TURN_CONTEXT)}`)

    const run = await runProofCases({
      agent,
      command: agent,
      cases: proofCases(agent, nonce),
      plan,
      recorded,
      cwd,
      out
    })
    if (!run.allPass) allPass = false
    const summaries = run.summaries
    out(`\n=== summary — ${agent} ===`)
    for (const line of summaries) out(line)
    out(`PROOF: ${allPass ? 'PASS' : 'FAIL'}`)
  } finally {
    await host.close()
    rmSync(scratchDir, { recursive: true, force: true })
  }
  if (!allPass) process.exitCode = 1
}

/** An emission's `summary` when it carries one (the field each case pins), else a clipped rendering. */
function emissionSummary(emission: unknown): string {
  const value = typeof emission === 'string' ? safeJson(emission) : emission
  const summary = (value as { turnResult?: { summary?: unknown } } | null)?.turnResult?.summary
  return typeof summary === 'string' ? JSON.stringify(summary) : clip(JSON.stringify(emission), 60)
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
