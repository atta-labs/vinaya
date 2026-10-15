import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { briefHash, redact } from '@attalabs/aeg-core'
import type { LoopDeps, LoopResult } from '../../src/lib/dev-review-loop.js'
import { DeveloperTurnResultPause } from '../../src/lib/dev-review-loop/turn-result.js'
import {
  readClaudeTurnOutput,
  readCodexTurnOutput,
  type TurnRead,
  type TurnResultAdapter,
  type TurnResultRecord
} from '../../src/lib/dev-review-loop/turn-result.js'
import {
  classifyRoleAttemptOutcome,
  type DispatchFailureReason,
  type DispatchHandle,
  isReviewerResume,
  parseClaudeResumeId,
  parseCodexResumeId,
  REVIEWER_RESUME_REFUSED_REASON,
  vendorResumeArgs,
  vendorSessionArgs
} from '../../src/lib/dispatch.js'
import { developerTurnResultJsonSchema } from '../../src/lib/developer-turn-result.js'
import { agentControlsRefusal } from '../../src/lib/enforcement-controls.js'
import { classifyReviewOutcome, type ReviewBinding, reviewResultJsonSchema } from '../../src/lib/review-result.js'
import { runPath } from '../../src/lib/run-paths.js'
import {
  createDevToolsMcpServer,
  type DevToolContext,
  type DevToolRefusal,
  devToolError
} from '../../src/lib/task-tools/dev-tools-server.js'
import {
  claudeDevToolsArgs,
  codexDevToolsMcpTable,
  DEV_TOOLS_TOOL_TIMEOUT_SEC,
  devToolsMcpConfig,
  driverDevBridgeInvocation
} from '../../src/lib/task-tools/dev-tools-registration.js'
import { DEV_TOOLS_MCP_SERVER_NAME } from '../../src/lib/task-tools/dev-tools-names.js'
import { validatesJsonSchema } from '../../src/lib/task-tools/result-proof.js'
import { type GrantedRole, ROLE_TOOL_GRANTS } from '../../src/lib/task-tools/role-grants.js'
import {
  AGENT_TOOL_CATALOG,
  TOOL_EFFECT_STATES,
  TOOL_ERROR_CLASSES,
  TOOL_RETRY_DISPOSITIONS
} from '../../src/lib/task-tools/tool-catalog.js'
import {
  probeAgentSandbox,
  SANDBOX_PROBE_MARKER,
  type SandboxProbeResult,
  type SandboxProbeRun
} from '../../src/lib/worker-boundary.js'
import {
  CLEAN_REVIEWER,
  cleanupWorlds,
  developerDir,
  handoffIdsInPrompt,
  type LoopWorld,
  makeInProcessDeps,
  makeWorld,
  outboxLines,
  runLoopInProcess
} from '../lib/dev-review-loop-harness.js'

/**
 * The shared adapter-conformance suite (evaluation layer L4): one case list,
 * run unchanged on Claude Code and on Codex, against the contract the
 * developer-review controller holds every agent to
 * (`apps/cli/specs/dev-review-capabilities-contracts.md` §9).
 *
 * Every case names the role it exercises, the sessions it runs on, the
 * registry suites it executes and how the live run observes it. Its
 * deterministic driver runs the real controller code — the real loop, its
 * result acceptance and pause rules, the real dev-tools server and catalog,
 * the production vendor-stream readers, argv builders, registration writers
 * and sandbox probe — with only the forge and the agent faked: the fake agent
 * speaks each vendor's own stream format, so a case passes on an adapter only
 * when that adapter's real reader carries the outcome. Every assertion is on a
 * typed outcome or a controller record, never on a model's prose.
 *
 * Session rule: a Developer case runs on a first session and on a resumed
 * one; a reviewer case runs only on a fresh session, and the one reviewer case
 * on a resumed session is the refusal case.
 */

// --- adapters and sessions ----------------------------------------------------

export const CONTRACT_ADAPTERS = ['claude', 'codex'] as const
export type ContractAdapter = (typeof CONTRACT_ADAPTERS)[number]

/** The native structured-output channel each adapter delivers its one terminal result through. */
export const TURN_RESULT_ADAPTER: Record<ContractAdapter, TurnResultAdapter> = {
  claude: 'claude --json-schema',
  codex: 'codex --output-schema'
}

/** The capability-matrix adapter id each contract adapter fills. */
export const MATRIX_ADAPTER: Record<ContractAdapter, string> = { claude: 'claude-code', codex: 'codex' }

export const SESSION_KINDS = ['first', 'resumed', 'fresh'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]

export type CaseRole = 'developer' | 'reviewer' | 'host'

/** Where the live run reads a case's outcome: an existing live proof's named case, or this suite's own live dispatch. */
export type LiveBinding = {
  proof: 'result-proof' | 'review-result-proof' | 'dev-proof' | 'contract-dispatch'
  /** The proof's own case name, exactly as its summary line prints it; `dev-proof` prints one verdict, named `PROOF`. */
  case: string
}

/**
 * A difference between the adapters in how they meet a case, declared in the
 * capability matrix (`apps/cli/specs/dev-review-engine-capability-matrix.md`,
 * "Declared differences in the adapter conformance suite"). `supported: false`
 * marks a difference the adapter does not cover — a named gap the case still
 * runs against.
 */
export type DeclaredDifference = { matrixRow: string; difference: string; supported: boolean }

export type AdapterContractCase = {
  id: string
  objective: 'O1' | 'O2' | 'O3'
  role: CaseRole
  /** The guarantee the case proves, in one sentence. */
  contract: string
  sessions: readonly SessionKind[]
  /** Set on the one case whose expected outcome is a refusal of the session itself. */
  refusal?: true
  /** The module-registry suites (`apps/cli/tests/eval/registry/modules.json`) this case executes. */
  suites: readonly string[]
  live: readonly LiveBinding[]
  /** Why the live report must not promote this controller-owned deterministic observation to PASS. */
  deterministicOnlyReason?: string
  differences: Partial<Record<ContractAdapter, DeclaredDifference>>
}

const DEV_SESSIONS = ['first', 'resumed'] as const
const RESULT_PROOF = (name: string): LiveBinding => ({ proof: 'result-proof', case: name })
const REVIEW_PROOF = (name: string): LiveBinding => ({ proof: 'review-result-proof', case: name })
const CONTRACT_DISPATCH = (name: string): LiveBinding => ({ proof: 'contract-dispatch', case: name })
const DEV_PROOF: LiveBinding = { proof: 'dev-proof', case: 'PROOF' }

/** The one case list both adapters run, in report order. */
export const ADAPTER_CONTRACT_CASES: readonly AdapterContractCase[] = [
  {
    id: 'catalog-listing',
    objective: 'O1',
    role: 'developer',
    contract:
      "The adapter registers the driver-run tool server under its own vendor mechanism, and the server lists exactly the role's granted tools, each defined by the canonical catalog.",
    sessions: DEV_SESSIONS,
    suites: ['developer-invocation.l4@1'],
    live: [DEV_PROOF, RESULT_PROOF('first session'), RESULT_PROOF('resumed session')],
    differences: {
      claude: {
        matrixRow: 'AD-CC-05',
        difference:
          'Registered by a strict, controller-written MCP configuration file; the session fails at start when its init event reports the server skipped or failed.',
        supported: true
      },
      codex: {
        matrixRow: 'AD-CX-05',
        difference:
          'Registered as a required MCP server table in the task-scoped configuration home, so a server that cannot start fails the session.',
        supported: true
      }
    }
  },
  {
    id: 'schema-validation',
    objective: 'O1',
    role: 'developer',
    contract:
      'A tool call whose arguments fail the catalog input schema is refused as invalid input before any effect, and the turn-result schema handed to the vendor refuses a value outside it.',
    sessions: DEV_SESSIONS,
    suites: ['developer-result.l4@1', 'developer-invocation.l4@1'],
    live: [
      RESULT_PROOF('missing required source — blocked by the schema'),
      RESULT_PROOF('unknown finding id — blocked by the schema')
    ],
    differences: {}
  },
  {
    id: 'error-classes',
    objective: 'O1',
    role: 'developer',
    contract:
      'Every error class of the shared error model reaches the agent as a readable tool result carrying its class, retry disposition and effect state, never as a transport failure.',
    sessions: DEV_SESSIONS,
    suites: ['developer-invocation.l4@1'],
    live: [],
    deterministicOnlyReason:
      'The deterministic driver delivers every error class through the real tool server and verifies its retryDisposition and effectState; the live dev-proof verdict does not identify those deliveries.',
    differences: {}
  },
  {
    id: 'result-delivery',
    objective: 'O1',
    role: 'developer',
    contract:
      "A valid turn result delivered through the adapter's native structured output is accepted exactly once and recorded as the round's one accepted attempt.",
    sessions: DEV_SESSIONS,
    suites: ['developer-invocation.l4@1', 'developer-result.l4@1'],
    live: [RESULT_PROOF('first session'), RESULT_PROOF('resumed session')],
    differences: {
      claude: {
        matrixRow: 'AD-CC-02',
        difference:
          "The schema is passed inline with `--json-schema`; the result is read only from the terminal `result` event's `structured_output`.",
        supported: true
      },
      codex: {
        matrixRow: 'AD-CX-02',
        difference:
          'The schema is a file passed with `--output-schema`; the result is the final agent message, read only when the turn completes.',
        supported: true
      }
    }
  },
  {
    id: 'malformed-output',
    objective: 'O1',
    role: 'developer',
    contract:
      'Malformed stream lines and a model output outside the schema never cross the adapter boundary: the attempt is rejected with nothing schema-valid recorded.',
    sessions: DEV_SESSIONS,
    suites: ['developer-invocation.l4@1'],
    live: [RESULT_PROOF('malformed model output')],
    differences: {}
  },
  {
    id: 'semantic-invalid',
    objective: 'O1',
    role: 'developer',
    contract: 'A schema-valid but semantically invalid result is rejected, with its typed failures recorded.',
    sessions: DEV_SESSIONS,
    suites: ['developer-result.l4@1'],
    live: [RESULT_PROOF('ruling request naming no permissible decision')],
    differences: {}
  },
  {
    id: 'precondition-retry',
    objective: 'O1',
    role: 'developer',
    contract:
      'A first result failing a completion precondition is rejected and recorded, the same session is resumed once with only the typed failures, and only the second, valid result is accepted.',
    sessions: DEV_SESSIONS,
    suites: ['developer-result.l4@1'],
    live: [CONTRACT_DISPATCH('precondition-retry')],
    differences: {}
  },
  {
    id: 'second-failure-pause',
    objective: 'O1',
    role: 'developer',
    contract: 'A second invalid result pauses the run with a typed reason; no review starts and nothing is published.',
    sessions: DEV_SESSIONS,
    suites: ['developer-result.l4@1'],
    live: [],
    deterministicOnlyReason:
      'The deterministic driver records two rejected attempts and observes the real controller pause after its one bounded same-session resumption; a live model cannot be required to repeat invalid output.',
    differences: {}
  },
  {
    id: 'provider-error',
    objective: 'O1',
    role: 'developer',
    contract: 'A provider error yields no accepted result.',
    sessions: DEV_SESSIONS,
    suites: ['developer-invocation.l4@1'],
    live: [RESULT_PROOF('provider error')],
    differences: {}
  },
  {
    id: 'cancellation',
    objective: 'O1',
    role: 'developer',
    contract: 'A cancelled run yields no accepted result and is never counted as a turn result.',
    sessions: DEV_SESSIONS,
    suites: ['developer-invocation.l4@1'],
    live: [RESULT_PROOF('cancelled run')],
    differences: {
      claude: {
        matrixRow: 'AD-CC-08',
        difference: 'The interrupted turn records no result; a resume continues from the next prompt.',
        supported: true
      },
      codex: {
        matrixRow: 'AD-CX-08',
        difference:
          "Codex documents no interrupt semantics for `codex exec`, nor what a resumed session holds for an interrupted turn; the runtime's process termination is the only cancellation.",
        supported: false
      }
    }
  },
  {
    id: 'context-exhaustion',
    objective: 'O1',
    role: 'developer',
    contract: 'A context-exhausted run yields no accepted result.',
    sessions: DEV_SESSIONS,
    suites: ['developer-invocation.l4@1'],
    live: [RESULT_PROOF('context exhaustion')],
    differences: {}
  },
  {
    id: 'timeout',
    objective: 'O1',
    role: 'developer',
    contract: 'A run that reaches its time limit is classified as timed out and yields no accepted result.',
    sessions: DEV_SESSIONS,
    suites: ['developer-invocation.l4@1'],
    live: [CONTRACT_DISPATCH('timeout')],
    differences: {}
  },
  {
    id: 'redaction',
    objective: 'O1',
    role: 'developer',
    contract:
      'A secret or home path carried in provider output or a rejected result never appears in a controller-composed prompt, record of the run, Log event or report; the rejected value is never echoed back.',
    sessions: DEV_SESSIONS,
    suites: ['developer-invocation.l4@1'],
    live: [CONTRACT_DISPATCH('redaction')],
    differences: {}
  },
  {
    id: 'reviewer-catalog-listing',
    objective: 'O1',
    role: 'reviewer',
    contract:
      'A reviewer session lists only the reviewer grant, `read_source`, and any Developer tool it calls is refused as unauthorized before a handler runs.',
    sessions: ['fresh'],
    suites: ['reviewer-validity.l4@1'],
    live: [],
    deterministicOnlyReason:
      'The deterministic driver inspects the reviewer grant directly; no live proof currently reports this case.',
    differences: {}
  },
  {
    id: 'reviewer-result-delivery',
    objective: 'O2',
    role: 'reviewer',
    contract:
      'Both reviewers return their ReviewResult through the native structured output, each on a fresh session that is never resumed, and both are accepted against the same review-input manifest.',
    sessions: ['fresh'],
    suites: ['reviewer-validity.l4@1'],
    live: [
      REVIEW_PROOF('round 1: concurrent reviewers, one manifest'),
      REVIEW_PROOF('round 2: concurrent reviewers, new head and manifest')
    ],
    differences: {}
  },
  {
    id: 'reviewer-invalid-result',
    objective: 'O1',
    role: 'reviewer',
    contract:
      'A malformed, role-mismatched, stale or semantically invalid reviewer result is no review, recorded with its typed reason.',
    sessions: ['fresh'],
    suites: ['reviewer-validity.l4@1'],
    live: [
      REVIEW_PROOF('role mismatch (code-reviewer dispatch reports security-reviewer)'),
      REVIEW_PROOF('wrong head'),
      REVIEW_PROOF('wrong manifest digest'),
      REVIEW_PROOF('objective id outside the brief'),
      REVIEW_PROOF('finding without a file'),
      REVIEW_PROOF('malformed model output')
    ],
    differences: {}
  },
  {
    id: 'reviewer-no-result',
    objective: 'O1',
    role: 'reviewer',
    contract: 'A reviewer provider error, cancellation or context exhaustion is no review, never an approval.',
    sessions: ['fresh'],
    suites: ['reviewer-validity.l4@1'],
    live: [
      REVIEW_PROOF('no structured result'),
      REVIEW_PROOF('cancelled run'),
      REVIEW_PROOF('provider error'),
      REVIEW_PROOF('context exhaustion')
    ],
    differences: {}
  },
  {
    id: 'reviewer-resume-refused',
    objective: 'O2',
    role: 'reviewer',
    contract:
      'An attempt to resume a reviewer session is refused before it starts, and a result from a resumed reviewer session is no review.',
    sessions: ['resumed'],
    refusal: true,
    suites: ['reviewer-validity.l4@1'],
    live: [REVIEW_PROOF('resume a reviewer session')],
    differences: {
      claude: {
        matrixRow: 'AD-CC-04',
        difference:
          'A Claude session resumes with `-p -r <session>`; the reviewer refusal stops that argv being built.',
        supported: true
      },
      codex: {
        matrixRow: 'AD-CX-04',
        difference:
          'A Codex session resumes with `exec resume <session>`; the reviewer refusal stops that argv being built.',
        supported: true
      }
    }
  },
  {
    id: 'role-context-developer',
    objective: 'O3',
    role: 'developer',
    contract:
      "The Developer's role instructions and the rendered brief reach the vendor's loaded location — the prompt the CLI reads from standard input, and the repository instruction file the vendor loads — and the brief delivered matches the digest the controller's context packet names.",
    sessions: DEV_SESSIONS,
    suites: ['role-context.l4@1'],
    live: [],
    deterministicOnlyReason:
      "The deterministic driver hashes the rendered brief and each vendor's loaded repository instruction path; no live proof exposes those loaded bytes by digest.",
    differences: {
      claude: {
        matrixRow: 'AD-CC-11',
        difference:
          'Claude Code loads `CLAUDE.md`, which imports `AGENTS.md`; the prompt is read from standard input in print mode.',
        supported: true
      },
      codex: {
        matrixRow: 'AD-CX-11',
        difference:
          'Codex loads `AGENTS.md` itself; role context is the prompt, read from standard input after the trailing `-`, plus the task-scoped configuration home.',
        supported: true
      }
    }
  },
  {
    id: 'role-context-reviewer',
    objective: 'O3',
    role: 'reviewer',
    contract:
      "Each reviewer's role instructions and the review-input manifest reach its fresh session's prompt, and the manifest digest the prompt names is the one the controller binds the result to.",
    sessions: ['fresh'],
    suites: ['role-context.l4@1'],
    live: [],
    deterministicOnlyReason:
      "The deterministic driver binds each fresh reviewer's prompt and result to the staged manifest digest; no live proof exposes the loaded prompt by digest.",
    differences: {}
  },
  {
    id: 'host-readiness',
    objective: 'O3',
    role: 'host',
    contract:
      'A host whose sandbox is missing, fails on its first command, or lacks the adapter settings file refuses before any agent turn is counted; a ready host dispatches.',
    sessions: ['first'],
    suites: ['host-readiness.l4@1'],
    live: [CONTRACT_DISPATCH('host-readiness')],
    differences: {
      claude: {
        matrixRow: 'CF-CC-LINUX',
        difference:
          "The readiness probe is one short print-mode turn asked to run the probe command in the dispatch's own sandbox, retried once when no command ran.",
        supported: true
      },
      codex: {
        matrixRow: 'CF-CX-LINUX',
        difference: 'The readiness probe runs the probe command through `codex sandbox` and starts no model.',
        supported: true
      }
    }
  }
]

/**
 * Every way the case list breaks the per-role session rule, empty when it
 * holds: a Developer case runs on first and resumed sessions; a reviewer case
 * runs only on a fresh session, unless it is the refusal case on a resumed one.
 */
export function sessionRuleViolations(cases: readonly AdapterContractCase[]): string[] {
  const out: string[] = []
  for (const c of cases) {
    const sessions = [...c.sessions].sort().join(',')
    if (c.role === 'developer' && sessions !== 'first,resumed') {
      out.push(`${c.id}: a Developer case runs on first and resumed sessions, not ${sessions}`)
    }
    if (c.role === 'reviewer') {
      if (c.refusal === true && sessions !== 'resumed') out.push(`${c.id}: the refusal case runs on a resumed session`)
      if (c.refusal !== true && sessions !== 'fresh') {
        out.push(`${c.id}: a reviewer case runs only on a fresh session, not ${sessions}`)
      }
    }
    if (c.refusal === true && c.role !== 'reviewer') out.push(`${c.id}: only a reviewer session is refused`)
  }
  return out
}

/** Every declared difference, one per case and adapter, in case order. */
export function declaredDifferences(): Array<{ caseId: string; adapter: ContractAdapter } & DeclaredDifference> {
  return ADAPTER_CONTRACT_CASES.flatMap((c) =>
    CONTRACT_ADAPTERS.flatMap((adapter) => {
      const d = c.differences[adapter]
      return d === undefined ? [] : [{ caseId: c.id, adapter, ...d }]
    })
  )
}

// --- vendor streams -----------------------------------------------------------

/** What the fake agent's stream carries, independent of the vendor that speaks it. */
export type StreamScript =
  /** A terminal structured result; `noise` interleaves malformed lines the reader must skip. */
  | { kind: 'result'; value: unknown; noise?: boolean }
  /** A final model message that is plain text, not a structured result. */
  | { kind: 'text'; text: string }
  | { kind: 'provider-error'; message: string }
  | { kind: 'context-exhausted' }
  /** The stream stops after an emission, before any terminal event — a cancelled or timed-out run. */
  | { kind: 'truncated'; value: unknown }

const NOISE_LINES = [
  'not a json line at all',
  '{"type":"assistant","message":',
  '[1,2,3]',
  '{"type":"result","subtype":"success","is_error":false,"structured_output":{"turnResult":'
]

const json = (value: unknown): string => JSON.stringify(value)

/** One run's stdout exactly as each vendor's headless JSON stream prints it. */
export function vendorStream(adapter: ContractAdapter, sessionId: string, script: StreamScript): string {
  const lines: string[] = []
  if (adapter === 'claude') {
    lines.push(
      json({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        mcp_servers: [{ name: DEV_TOOLS_MCP_SERVER_NAME, status: 'connected' }]
      })
    )
    const emit = (value: unknown) =>
      lines.push(
        json({
          type: 'assistant',
          session_id: sessionId,
          message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'StructuredOutput', input: value }] }
        })
      )
    switch (script.kind) {
      case 'result':
        if (script.noise) lines.push(...NOISE_LINES)
        emit(script.value)
        lines.push(
          json({
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: sessionId,
            structured_output: script.value
          })
        )
        break
      case 'text':
        lines.push(
          json({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: script.text })
        )
        break
      case 'provider-error':
        lines.push(
          json({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            session_id: sessionId,
            errors: [script.message]
          })
        )
        break
      case 'context-exhausted':
        lines.push(
          json({
            type: 'result',
            subtype: 'success',
            is_error: true,
            session_id: sessionId,
            result: 'Prompt is too long'
          })
        )
        break
      case 'truncated':
        emit(script.value)
        break
    }
  } else {
    lines.push(json({ type: 'thread.started', thread_id: sessionId }), json({ type: 'turn.started' }))
    const message = (text: string) =>
      lines.push(json({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } }))
    switch (script.kind) {
      case 'result':
        if (script.noise) lines.push(...NOISE_LINES)
        message(json(script.value))
        lines.push(json({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }))
        break
      case 'text':
        message(script.text)
        lines.push(json({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }))
        break
      case 'provider-error':
        lines.push(
          json({ type: 'error', message: script.message }),
          json({ type: 'turn.failed', error: { message: script.message } })
        )
        break
      case 'context-exhausted': {
        const exhausted =
          'Codex ran out of room in the model context window. Start a new thread or clear earlier history.'
        lines.push(
          json({ type: 'error', message: exhausted }),
          json({ type: 'turn.failed', error: { message: exhausted } })
        )
        break
      }
      case 'truncated':
        message(json(script.value))
        break
    }
  }
  return `${lines.join('\n')}\n`
}

/** The production reader for an adapter's stream. */
export function readTurn(adapter: ContractAdapter, stdout: string): TurnRead {
  return adapter === 'claude' ? readClaudeTurnOutput(stdout) : readCodexTurnOutput(stdout)
}

/** The production session-id parser the dispatcher binds a resume to. */
export function streamSessionId(adapter: ContractAdapter, stdout: string): string | null {
  return adapter === 'claude' ? parseClaudeResumeId(stdout) : parseCodexResumeId(stdout)
}

// --- result fixtures ----------------------------------------------------------

export function completedResult(fields: {
  summary: string
  addressedFindingIds?: readonly string[]
  sourceUses?: ReadonlyArray<{ source: string; use: string }>
  confidence?: unknown
}): unknown {
  return {
    turnResult: {
      schemaVersion: 1,
      status: 'completed',
      summary: fields.summary,
      confidence: fields.confidence ?? 90,
      confidenceExplanation: 'the fixture work is done',
      addressedFindingIds: [...(fields.addressedFindingIds ?? [])],
      sourceUses: [...(fields.sourceUses ?? [])],
      reportedChecks: null
    }
  }
}

/** Outside the schema: a word where a number belongs, a missing field and an extra one. */
export const MALFORMED_RESULT = {
  turnResult: { schemaVersion: 1, status: 'completed', confidence: 'high', notes: 'extra field' }
}

/**
 * A secret-shaped token a provider might print, planted to prove it never travels. Assembled at run time so
 * the source itself carries no credential-shaped literal for the publication scan to flag.
 */
export const PLANTED_SECRET = [
  'sk',
  'ant',
  'api03',
  'PLANTEDconformanceSECRETabcdefghijklmnopqrstuvwxyz0123456789'
].join('-')

/** The one required source the precondition cases name. */
export const REQUIRED_SOURCE = 'https://code.claude.com/docs/en/cli-reference'

// --- the deterministic driver: the real loop, a fake agent per vendor --------

/** One scripted Developer dispatch: what its stream carries and what the dispatch reports beside it. */
export type DeveloperStep = {
  stream: StreamScript
  failureReason?: DispatchFailureReason
  documentation?: { sources: string[]; countedReads: string[] }
}

/** One scripted reviewer dispatch; `undefined` re-delivers the world's own clean review through the adapter's stream. */
export type ReviewerStep = { stream: StreamScript; failureReason?: DispatchFailureReason } | undefined

/** One dispatch the adapter recorded: what the loop asked for and what the agent's stream said. */
export type AdapterDispatch = {
  role: string
  round: number
  attempt: number
  /** The session the loop asked to resume, `null` for a fresh one. */
  requestedResume: string | null
  /** The argv the production builder makes for that request. */
  argv: string[]
  prompt: string
  stdout: string
  sessionId: string | null
  read: TurnRead
}

export type AdapterRun = {
  world: LoopWorld
  result: LoopResult
  dispatches: AdapterDispatch[]
}

/**
 * Runs the real loop with the agent speaking `adapter`'s stream format. The
 * world's own fakes decide bookkeeping (the push, the reviewer's head and
 * manifest binding); this adapter re-delivers every result through the
 * vendor stream, so the loop sees only what the production reader made of it.
 */
export async function runOnAdapter(
  adapter: ContractAdapter,
  world: LoopWorld,
  scripts: {
    developer?: (round: number, attempt: number, prompt: string) => DeveloperStep | undefined
    reviewer?: (role: 'code-reviewer' | 'security', round: number, bound: unknown) => ReviewerStep
  } = {},
  overrides: Partial<LoopDeps> = {}
): Promise<AdapterRun> {
  const base = makeInProcessDeps(world)
  const dispatches: AdapterDispatch[] = []
  let sessions = 0
  const deps: Partial<LoopDeps> = {
    dispatchRole: async (role, agent, prompt, opts): Promise<DispatchHandle> => {
      const handle = await base.dispatchRole!(role, agent, prompt, opts)
      const round = opts.round ?? 1
      const attempt = dispatches.filter((d) => d.role === role && d.round === round).length + 1
      const requestedResume = opts.resumeId ?? null
      const sessionId = requestedResume ?? `${adapter}-${role}-session-${++sessions}`
      const argv = requestedResume === null ? vendorSessionArgs(adapter) : vendorResumeArgs(adapter, requestedResume)
      let stream: StreamScript
      let failureReason: DispatchFailureReason | undefined
      let documentation: DeveloperStep['documentation']
      if (role === 'developer') {
        const step = scripts.developer?.(round, attempt, prompt)
        stream = step?.stream ?? {
          kind: 'result',
          value: completedResult({ summary: `round ${round} done`, addressedFindingIds: handoffIdsInPrompt(prompt) })
        }
        failureReason = step?.failureReason
        documentation = step?.documentation
      } else {
        const step = scripts.reviewer?.(
          role === 'code-reviewer' ? 'code-reviewer' : 'security',
          round,
          handle.reviewOutput?.raw ?? null
        )
        stream = step?.stream ?? { kind: 'result', value: handle.reviewOutput?.raw ?? null }
        failureReason = step?.failureReason ?? handle.failureReason
      }
      const stdout = vendorStream(adapter, sessionId, stream)
      const read = readTurn(adapter, stdout)
      dispatches.push({
        role,
        round,
        attempt,
        requestedResume,
        argv,
        prompt,
        stdout,
        sessionId: streamSessionId(adapter, stdout),
        read
      })
      const output = { adapter: TURN_RESULT_ADAPTER[adapter], raw: read.raw, event: read.event }
      const failed = failureReason !== undefined
      return {
        ...handle,
        exitCode: failed ? null : 0,
        timedOut: failureReason === 'timeout',
        resumeId: streamSessionId(adapter, stdout),
        ...(failed ? { failureReason } : { failureReason: undefined }),
        ...(role === 'developer'
          ? { turnOutput: output, documentation: documentation ?? { sources: [], countedReads: [] } }
          : { reviewOutput: { ...output, terminal: read.terminal, errors: read.errors } })
      }
    },
    ...overrides
  }
  const result = await runLoopInProcess(world, { task: world.task, agent: adapter }, deps)
  return { world, result, dispatches }
}

/** A world whose round-1 code reviewer raises one blocker, so round 2 resumes the Developer's session with a finding to answer. */
export function resumedSessionWorld(): LoopWorld {
  return makeWorld({
    roleOutcomes: {
      1: {
        reviewer: {
          ...CLEAN_REVIEWER,
          findings: 'BLOCKER|smoke.ts:1|deliberate round-1 blocker',
          sessionId: 'rev-session-1'
        }
      }
    }
  })
}

/** The round a session kind's scripted turn lands in: a first session is round 1; a resumed one is round 2. */
export function roundOf(session: SessionKind): number {
  return session === 'resumed' ? 2 : 1
}

function worldFor(session: SessionKind): LoopWorld {
  return session === 'resumed' ? resumedSessionWorld() : makeWorld()
}

/** The turn-result records the controller wrote for a round, in attempt order. */
export function turnRecords(world: LoopWorld, round: number): TurnResultRecord[] {
  const dir = developerDir(world, round)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => /^turn-result-\d+\.json$/.test(n))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as TurnResultRecord)
}

/** The controller's own no-review records for a run, as `<role>:<reason>` — the code reviewer's role reads `reviewer`. */
export function reviewNotAccepted(world: LoopWorld): string[] {
  const path = runPath(world.runtimeDir, world.task, { area: 'output', file: 'driver.log' })
  if (!existsSync(path)) return []
  return [
    ...readFileSync(path, 'utf8').matchAll(/review_not_accepted: round=\d+ attempt=\d+ role=(\S+) reason=(\S+)/g)
  ].map((m) => `${m[1]}:${m[2]}`)
}

export type CaseVerdict = { failures: string[]; observed: Record<string, unknown> }

type Check = (adapter: ContractAdapter, session: SessionKind) => Promise<CaseVerdict>

function verdict(observed: Record<string, unknown>, failures: Array<string | false | null | undefined>): CaseVerdict {
  return { observed, failures: failures.filter((f): f is string => typeof f === 'string') }
}

function developerDispatches(run: AdapterRun, round: number): AdapterDispatch[] {
  return run.dispatches.filter((d) => d.role === 'developer' && d.round === round)
}

/** The session-kind facts every Developer case checks: a first session starts fresh, a resumed one continues round 1's session. */
function sessionFailures(run: AdapterRun, session: SessionKind): string[] {
  const round = roundOf(session)
  const [first] = developerDispatches(run, round)
  if (first === undefined) return [`no Developer dispatch in round ${round}`]
  if (session === 'first') {
    return first.requestedResume === null ? [] : [`a first session asked to resume ${first.requestedResume}`]
  }
  const [roundOne] = developerDispatches(run, 1)
  const out: string[] = []
  if (first.requestedResume === null || first.requestedResume !== roundOne?.sessionId) {
    out.push(
      `round 2 did not resume round 1's session (${roundOne?.sessionId ?? 'none'}): asked ${first.requestedResume}`
    )
  }
  if (first.requestedResume !== null && !first.argv.includes(first.requestedResume)) {
    out.push('the resume argv does not carry the session id')
  }
  return out
}

/** Runs one Developer scenario: `step` scripts the scenario round's attempts; every other dispatch is the default valid turn. */
async function developerScenario(
  adapter: ContractAdapter,
  session: SessionKind,
  step: (attempt: number, prompt: string) => DeveloperStep | undefined
): Promise<AdapterRun> {
  const round = roundOf(session)
  return runOnAdapter(adapter, worldFor(session), {
    developer: (r, attempt, prompt) => (r === round ? step(attempt, prompt) : undefined)
  })
}

/** Handoff ids the scenario round must cite: none in a first session, round 1's finding in a resumed one. */
function handoffFor(session: SessionKind): string[] {
  return session === 'resumed' ? ['R1-CR-1'] : []
}

function faultedNeverAccepted(run: AdapterRun, round: number, marker: string): string | null {
  const accepted = turnRecords(run.world, round).filter(
    (r) => r.outcome === 'accepted' && r.result !== null && r.result.summary === marker
  )
  return accepted.length > 0 ? `the faulted turn's result "${marker}" was accepted` : null
}

/** A Developer dispatch that faults (`failureReason`, or a stream with no result) must leave no accepted result of its own. */
async function faultCase(
  adapter: ContractAdapter,
  session: SessionKind,
  marker: string,
  stream: StreamScript,
  failureReason?: DispatchFailureReason
): Promise<CaseVerdict> {
  const round = roundOf(session)
  const run = await developerScenario(adapter, session, (attempt) =>
    attempt === 1 ? { stream, ...(failureReason ? { failureReason } : {}) } : undefined
  )
  const [faulted] = developerDispatches(run, round)
  const records = turnRecords(run.world, round)
  return verdict(
    {
      decision: run.result.finalDecision,
      read: { event: faulted?.read.event ?? null, terminal: faulted?.read.terminal ?? null },
      records: records.map((r) => [r.attempt, r.outcome])
    },
    [
      ...sessionFailures(run, session),
      faulted?.read.event !== null && `the faulted stream crossed the adapter boundary (${faulted?.read.event})`,
      faultedNeverAccepted(run, round, marker),
      records.length > 0 && records[0]!.outcome === 'accepted' && "the faulted attempt's record reads accepted"
    ]
  )
}

const DEVELOPER_CHECKS: Record<string, Check> = {
  'catalog-listing': async (adapter, session) => {
    const bridge = driverDevBridgeInvocation('/tmp/vinaya-conformance.sock', 'vinaya')
    const registration =
      adapter === 'claude'
        ? {
            server: Object.keys(devToolsMcpConfig(bridge).mcpServers),
            command: devToolsMcpConfig(bridge).mcpServers[DEV_TOOLS_MCP_SERVER_NAME]?.command,
            flags: claudeDevToolsArgs('/tmp/dev-tools.mcp.json')
          }
        : { table: codexDevToolsMcpTable(bridge) }
    const registrationFailures =
      adapter === 'claude'
        ? [
            (registration as { server: string[] }).server.join() !== DEV_TOOLS_MCP_SERVER_NAME &&
              'the Claude configuration does not register exactly the dev-tools server',
            (registration as { command?: string }).command !== bridge.command &&
              'the Claude configuration runs another command than the bridge',
            !(registration as { flags: string[] }).flags.includes('--strict-mcp-config') &&
              'the Claude registration is not strict'
          ]
        : [
            !(registration as { table: string }).table.includes(`[mcp_servers.${DEV_TOOLS_MCP_SERVER_NAME}]`) &&
              'the Codex configuration does not register the dev-tools server',
            !/^required = true$/m.test((registration as { table: string }).table) &&
              'the Codex registration is not required',
            !(registration as { table: string }).table.includes(`tool_timeout_sec = ${DEV_TOOLS_TOOL_TIMEOUT_SEC}`) &&
              'the Codex registration declares no tool timeout'
          ]
    // Each dispatch, first or resumed, starts its own host: list it as that session sees it.
    const listed = await listTools('developer')
    const catalog = new Map(AGENT_TOOL_CATALOG.map((t) => [t.name, t]))
    const schemaMismatch = listed.tools.filter(
      (t) => JSON.stringify(t.inputSchema) !== JSON.stringify(catalog.get(t.name)?.inputSchema)
    )
    return verdict({ session, registration, listed: listed.names }, [
      ...registrationFailures,
      listed.names.join() !== [...ROLE_TOOL_GRANTS.developer].sort().join() &&
        `the server lists ${listed.names.join()}, not the Developer grant`,
      schemaMismatch.length > 0 &&
        `listed input schemas differ from the catalog: ${schemaMismatch.map((t) => t.name).join()}`
    ])
  },

  'schema-validation': async (adapter, session) => {
    const refused = await callTool('developer', 'publish_changes', { header: 42 })
    const schema = developerTurnResultJsonSchema({ knownFindingIds: handoffFor(session), requiredSources: [] })
    const valid = completedResult({ summary: 'ok', addressedFindingIds: handoffFor(session) })
    // The adapter receives the schema in its own form: inline for Claude, a staged file for Codex.
    const delivered = adapter === 'claude' ? JSON.parse(JSON.stringify(schema)) : stageSchemaFile(schema)
    return verdict({ session, refused: refused.error }, [
      refused.error?.errorClass !== 'invalid_input' && `a bad argument was refused as ${refused.error?.errorClass}`,
      refused.error?.effectState !== 'not_started' && 'a bad argument started an effect',
      !validatesJsonSchema(delivered, valid) && 'the delivered schema refuses a valid result',
      validatesJsonSchema(delivered, MALFORMED_RESULT) && 'the delivered schema accepts a malformed result'
    ])
  },

  'error-classes': async (_adapter, session) => {
    const crossed: Record<string, DevToolRefusal | null> = {}
    for (const errorClass of TOOL_ERROR_CLASSES) {
      const refusal = devToolError(errorClass, 'never', 'not_started', 'conformance', `${errorClass} refusal`, 'none')
      const result = await callTool(
        'developer',
        'run_checks',
        {},
        { runChecks: async () => ({ ok: false, error: refusal }) }
      )
      crossed[errorClass] = result.isError ? result.error : null
    }
    const missing = TOOL_ERROR_CLASSES.filter((c) => crossed[c]?.errorClass !== c)
    const malformedAxes = Object.values(crossed).filter(
      (e) =>
        e === null ||
        !(TOOL_RETRY_DISPOSITIONS as readonly string[]).includes(e.retryDisposition) ||
        !(TOOL_EFFECT_STATES as readonly string[]).includes(e.effectState)
    )
    const ungranted = await callTool('developer', 'read_source', { sourceId: REQUIRED_SOURCE })
    return verdict({ session, classes: Object.keys(crossed), ungranted: ungranted.error }, [
      missing.length > 0 && `error classes that did not reach the agent intact: ${missing.join()}`,
      malformedAxes.length > 0 && 'a refusal lost its retry disposition or effect state',
      ungranted.error?.errorClass !== 'unauthorized' && 'an ungranted tool was not refused as unauthorized'
    ])
  },

  'result-delivery': async (adapter, session) => {
    const round = roundOf(session)
    const run = await developerScenario(adapter, session, (attempt, prompt) =>
      attempt === 1
        ? {
            stream: {
              kind: 'result',
              value: completedResult({ summary: 'delivered', addressedFindingIds: handoffIdsInPrompt(prompt) })
            }
          }
        : undefined
    )
    const records = turnRecords(run.world, round)
    const [dispatch] = developerDispatches(run, round)
    return verdict({ decision: run.result.finalDecision.type, records: records.map((r) => [r.attempt, r.outcome]) }, [
      ...sessionFailures(run, session),
      dispatch?.read.terminalResults !== 1 && `the stream carried ${dispatch?.read.terminalResults} terminal results`,
      JSON.stringify(records.map((r) => [r.attempt, r.outcome])) !== '[[1,"accepted"]]' &&
        'the round did not record exactly one accepted attempt',
      records[0]?.result?.summary !== 'delivered' && 'the accepted result is not the delivered one',
      run.result.finalDecision.type !== 'publish' && `the run ended ${run.result.finalDecision.type}`
    ])
  },

  'malformed-output': async (adapter, session) => {
    const round = roundOf(session)
    const run = await developerScenario(adapter, session, (attempt, prompt) =>
      attempt === 1
        ? {
            stream:
              adapter === 'codex'
                ? { kind: 'text', text: 'Done. Confidence: high.' }
                : { kind: 'result', value: MALFORMED_RESULT, noise: true }
          }
        : {
            stream: {
              kind: 'result',
              value: completedResult({ summary: 'corrected', addressedFindingIds: handoffIdsInPrompt(prompt) })
            }
          }
    )
    const records = turnRecords(run.world, round)
    return verdict(
      { records: records.map((r) => [r.attempt, r.outcome, r.result === null ? 'nothing crossed' : 'crossed']) },
      [
        ...sessionFailures(run, session),
        records[0]?.outcome !== 'rejected' && 'the malformed attempt was not rejected',
        records[0]?.result !== null && 'a malformed output crossed the adapter boundary as a schema-valid result',
        records.filter((r) => r.outcome === 'accepted').some((r) => r.attempt === 1) &&
          'the malformed attempt was accepted'
      ]
    )
  },

  'semantic-invalid': async (adapter, session) => {
    const round = roundOf(session)
    const run = await developerScenario(adapter, session, (attempt, prompt) =>
      attempt === 1
        ? {
            stream: { kind: 'result', value: completedResult({ summary: 'invalid', addressedFindingIds: ['R9-XX-1'] }) }
          }
        : {
            stream: {
              kind: 'result',
              value: completedResult({ summary: 'corrected', addressedFindingIds: handoffIdsInPrompt(prompt) })
            }
          }
    )
    const records = turnRecords(run.world, round)
    return verdict({ records: records.map((r) => [r.attempt, r.outcome, r.failures]) }, [
      ...sessionFailures(run, session),
      records[0]?.outcome !== 'rejected' && 'the semantically invalid result was not rejected',
      records[0]?.result === null && 'the schema-valid result was not recorded with its rejection',
      (records[0]?.failures.length ?? 0) === 0 && 'the rejection carries no typed failure'
    ])
  },

  'precondition-retry': async (adapter, session) => {
    const round = roundOf(session)
    const run = await developerScenario(adapter, session, (attempt) => {
      const value = completedResult({
        summary: `attempt ${attempt}`,
        addressedFindingIds: handoffFor(session),
        sourceUses: [{ source: REQUIRED_SOURCE, use: 'the resume flag' }]
      })
      // Completion requires a receipt for every cited required source: the first attempt has none.
      const countedReads = attempt === 1 ? [] : [REQUIRED_SOURCE]
      return { stream: { kind: 'result', value }, documentation: { sources: [REQUIRED_SOURCE], countedReads } }
    })
    const records = turnRecords(run.world, round)
    const dispatches = developerDispatches(run, round)
    const correction = dispatches[1]
    return verdict(
      {
        records: records.map((r) => [r.attempt, r.outcome]),
        resumed: dispatches.map((d) => d.requestedResume),
        decision: run.result.finalDecision.type
      },
      [
        ...sessionFailures(run, session),
        JSON.stringify(records.map((r) => [r.attempt, r.outcome])) !== '[[1,"rejected"],[2,"accepted"]]' &&
          `records read ${JSON.stringify(records.map((r) => [r.attempt, r.outcome]))}`,
        !(records[0]?.failures.join() ?? '').includes('delivery receipt') &&
          'the rejection does not name the missing delivery receipt',
        dispatches.length !== 2 && `the round dispatched the Developer ${dispatches.length} times`,
        correction !== undefined &&
          correction.requestedResume !== dispatches[0]?.sessionId &&
          'the correction did not resume the same session',
        records[1]?.result?.summary !== 'attempt 2' && 'the accepted result is not the second one',
        run.result.finalDecision.type !== 'publish' && `the run ended ${run.result.finalDecision.type}`
      ]
    )
  },

  'second-failure-pause': async (adapter, session) => {
    const round = roundOf(session)
    const run = await developerScenario(adapter, session, (attempt) => ({
      stream: {
        kind: 'result',
        value: completedResult({ summary: `attempt ${attempt}`, addressedFindingIds: ['R9-XX-1'] })
      }
    }))
    const records = turnRecords(run.world, round)
    const decision = run.result.finalDecision as { type: string; reason?: string; detail?: string }
    const reviewedAfter = run.dispatches.some((d) => d.role !== 'developer' && d.round === round)
    return verdict({ decision, records: records.map((r) => r.outcome) }, [
      ...sessionFailures(run, session),
      decision.type !== 'pause' && `the run ended ${decision.type}, not a pause`,
      decision.reason !== new DeveloperTurnResultPause('rejected', '').pauseReason &&
        `the pause reason is ${decision.reason}`,
      !(decision.detail ?? '').includes(`rejected twice in round ${round}`) &&
        'the pause detail names no second rejection',
      records.map((r) => r.outcome).join() !== 'rejected,rejected' && 'the round did not record two rejections',
      reviewedAfter && 'a reviewer started after the second rejection',
      run.world.publishedRounds.includes(round) && 'the round was published'
    ])
  },

  'provider-error': (adapter, session) =>
    faultCase(adapter, session, 'unused', { kind: 'provider-error', message: 'API Error: 529 overloaded' }),

  cancellation: (adapter, session) =>
    faultCase(
      adapter,
      session,
      'cancelled',
      { kind: 'truncated', value: completedResult({ summary: 'cancelled' }) },
      'signal'
    ),

  'context-exhaustion': (adapter, session) => faultCase(adapter, session, 'unused', { kind: 'context-exhausted' }),

  timeout: async (adapter, session) => {
    const v = await faultCase(
      adapter,
      session,
      'timed out',
      { kind: 'truncated', value: completedResult({ summary: 'timed out' }) },
      'timeout'
    )
    const classified = classifyRoleAttemptOutcome(false, true, false, null)
    v.observed.classified = classified
    if (classified !== 'timed_out') v.failures.push(`a timed-out attempt classifies as ${classified}`)
    return v
  },

  redaction: async (adapter, session) => {
    const round = roundOf(session)
    const run = await developerScenario(adapter, session, (attempt, prompt) =>
      attempt === 1
        ? {
            stream: {
              kind: 'result',
              value: completedResult({ summary: `leaked ${PLANTED_SECRET}`, addressedFindingIds: ['R9-XX-1'] })
            }
          }
        : {
            stream: {
              kind: 'result',
              value: completedResult({ summary: 'clean', addressedFindingIds: handoffIdsInPrompt(prompt) })
            }
          }
    )
    const prompts = run.dispatches.map((d) => d.prompt).join('\n')
    const events = JSON.stringify(outboxLines(run.world))
    const comments = JSON.stringify(run.world.postedComments)
    const redacted = redact({ error: PLANTED_SECRET, path: `${run.world.home}/x` }, run.world.home)
    return verdict({ round }, [
      ...sessionFailures(run, session),
      prompts.includes(PLANTED_SECRET) && 'a controller-composed prompt echoed the rejected value',
      events.includes(PLANTED_SECRET) && 'a Log event carries the planted secret',
      comments.includes(PLANTED_SECRET) && 'a posted comment carries the planted secret',
      JSON.stringify(redacted).includes(PLANTED_SECRET) && 'the event redactor kept the planted secret',
      JSON.stringify(redacted).includes(run.world.home) && 'the event redactor kept the home path'
    ])
  },

  'role-context-developer': async (adapter, session) => {
    const doctrine = `DEVELOPER DOCTRINE ${createHash('sha256').update(adapter).digest('hex').slice(0, 12)}`
    const world = worldFor(session)
    world.developerDoctrine = doctrine
    const run = await runOnAdapter(adapter, world)
    const round = roundOf(session)
    const [dispatch] = developerDispatches(run, round)
    const [roundOne] = developerDispatches(run, 1)
    const prompt = dispatch?.prompt ?? ''
    const named = prompt.match(/^- brief @ hash:([0-9a-f]+)$/m)?.[1] ?? null
    const priorSession = prompt.match(/^- prior-session @ id:(\S+)$/m)?.[1] ?? null
    const delivered = world.frozenBrief
    const instructions = repositoryInstructions(adapter)
    // The CLI reads its prompt from standard input: Claude in print mode, Codex after the trailing `-`.
    const stdinArgv = adapter === 'claude' ? dispatch?.argv.includes('-p') : dispatch?.argv.at(-1) === '-'
    return verdict({ session, namedBriefDigest: named, priorSession, instructions: instructions.loaded }, [
      ...sessionFailures(run, session),
      !stdinArgv && 'the argv does not read the prompt from standard input',
      !(roundOne?.prompt ?? '').includes(doctrine) && "the session's first prompt does not carry the role instructions",
      // The rendered brief reaches the session in its first prompt; a resumed turn's packet names it by digest.
      !(roundOne?.prompt ?? '').includes(delivered.trimEnd()) &&
        "the session's first prompt does not carry the rendered brief",
      named !== briefHash(delivered) && `the packet names brief digest ${named}, not the delivered brief's`,
      session === 'resumed' &&
        priorSession !== dispatch?.requestedResume &&
        `the resumed packet names prior session ${priorSession}, not the session resumed`,
      ...instructions.failures
    ])
  }
}

/** The repository instruction file each vendor loads, read as that vendor reaches it, by digest. */
export function repositoryInstructions(adapter: ContractAdapter): { loaded: string; failures: string[] } {
  const root = join(import.meta.dir, '..', '..', '..', '..')
  const agents = join(root, 'AGENTS.md')
  if (!existsSync(agents)) return { loaded: 'none', failures: ['the repository has no AGENTS.md'] }
  const digest = sha256(readFileSync(agents, 'utf8'))
  if (adapter === 'codex') return { loaded: `AGENTS.md sha256:${digest}`, failures: [] }
  const claude = join(root, 'CLAUDE.md')
  const imports = existsSync(claude) ? /^@AGENTS\.md$/m.test(readFileSync(claude, 'utf8')) : false
  return {
    loaded: `CLAUDE.md -> AGENTS.md sha256:${digest}`,
    failures: imports
      ? []
      : ['CLAUDE.md does not import AGENTS.md, so Claude Code does not load the repository instructions']
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function stageSchemaFile(schema: unknown): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-adapter-contract-schema-'))
  try {
    const path = join(dir, 'developer-turn-result.schema.json')
    writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 })
    return JSON.parse(readFileSync(path, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- the dev-tools server, in process ---------------------------------------

/** A forge fake: every tool succeeds without touching anything. */
export function forgeFakeContext(overrides: Partial<DevToolContext> = {}): DevToolContext {
  return {
    publishChanges: async () => ({ ok: true, result: { pushedHead: 'a'.repeat(40) } }),
    openPullRequest: async () => ({ ok: true, result: { prNumber: 1 } }),
    updatePullRequestBody: async () => ({ ok: true, result: { prNumber: 1 } }),
    refreshEvidence: async () => ({ ok: true, result: { head: 'a'.repeat(40), checksPassed: true, evidence: 'EV' } }),
    readPullRequest: async () => ({
      ok: true,
      result: { prNumber: 1, state: 'OPEN', head: 'a'.repeat(40), checks: [], reviews: [], body: '', failedChecks: [] }
    }),
    runChecks: async () => ({ ok: true, result: { passed: true, output: 'green' } }),
    fetchDocumentation: async () => ({
      ok: false,
      error: devToolError('dependency_unavailable', 'never', 'not_started', 'forge-fake', 'no network', 'none')
    }),
    ...overrides
  }
}

async function listTools(
  role: GrantedRole
): Promise<{ names: string[]; tools: Array<{ name: string; inputSchema: unknown }> }> {
  const srv = createDevToolsMcpServer({ serverVersion: '0.0.0-conformance', context: forgeFakeContext(), role })
  const resp = JSON.parse((await srv.handleLine(json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))) as string) as {
    result: { tools: Array<{ name: string; inputSchema: unknown }> }
  }
  return { names: resp.result.tools.map((t) => t.name).sort(), tools: resp.result.tools }
}

async function callTool(
  role: GrantedRole,
  name: string,
  args: unknown,
  overrides: Partial<DevToolContext> = {}
): Promise<{ isError: boolean; error: DevToolRefusal | null }> {
  const srv = createDevToolsMcpServer({
    serverVersion: '0.0.0-conformance',
    context: forgeFakeContext(overrides),
    role
  })
  const resp = JSON.parse(
    (await srv.handleLine(
      json({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
    )) as string
  ) as { result: { isError?: boolean; structuredContent?: { error?: DevToolRefusal } } }
  return { isError: resp.result.isError === true, error: resp.result.structuredContent?.error ?? null }
}

// --- reviewer cases ------------------------------------------------------------

/** The binding the controller holds a reviewer's result to, read from the prompt it was dispatched with. */
function bindingFromPrompt(role: 'code-reviewer' | 'security', prompt: string): ReviewBinding {
  return {
    role: role === 'security' ? 'security-reviewer' : 'code-reviewer',
    headSha: prompt.match(/headSha ([0-9a-f]+)/)?.[1] ?? '',
    manifestDigest: prompt.match(/manifestDigest ([0-9a-f]+)/)?.[1] ?? '',
    objectiveIds: ['O1']
  }
}

function reviewerDispatches(run: AdapterRun): AdapterDispatch[] {
  return run.dispatches.filter((d) => d.role === 'code-reviewer' || d.role === 'security')
}

function freshSessionFailures(run: AdapterRun): string[] {
  const reviewers = reviewerDispatches(run)
  const out: string[] = []
  if (reviewers.length === 0) out.push('no reviewer was dispatched')
  for (const d of reviewers) {
    if (d.requestedResume !== null) out.push(`${d.role} round ${d.round} asked to resume ${d.requestedResume}`)
  }
  const ids = reviewers.map((d) => d.sessionId)
  if (new Set(ids).size !== ids.length) out.push('two reviewer dispatches shared a session')
  return out
}

const REVIEWER_CHECKS: Record<string, Check> = {
  'reviewer-catalog-listing': async () => {
    const out: Record<string, unknown> = {}
    const failures: Array<string | false> = []
    for (const role of ['code-reviewer', 'security'] as const) {
      const listed = await listTools(role)
      const ungranted = await callTool(role, 'publish_changes', { header: 'Fix(x): y' })
      out[role] = { listed: listed.names, ungranted: ungranted.error?.errorClass }
      failures.push(
        listed.names.join() !== 'read_source' && `${role} lists ${listed.names.join()}`,
        ungranted.error?.errorClass !== 'unauthorized' &&
          `${role} calling publish_changes was not refused as unauthorized`,
        ungranted.error?.effectState !== 'not_started' && `${role}'s refused call started an effect`
      )
    }
    return verdict(out, failures)
  },

  'reviewer-result-delivery': async (adapter) => {
    const run = await runOnAdapter(adapter, resumedSessionWorld())
    const reviewers = reviewerDispatches(run)
    const schemas = (['code-reviewer', 'security-reviewer'] as const).map((role) => reviewResultJsonSchema(role))
    const accepted = reviewers.filter((d) => {
      const role = d.role === 'security' ? 'security' : 'code-reviewer'
      const outcome = classifyReviewOutcome(
        {
          cancelled: false,
          resumed: false,
          terminal: d.read.terminal,
          errors: d.read.errors,
          hasResult: d.read.raw !== null,
          raw: d.read.raw
        },
        bindingFromPrompt(role, d.prompt)
      )
      return outcome.kind === 'review'
    })
    return verdict(
      { decision: run.result.finalDecision.type, reviewers: reviewers.map((d) => [d.role, d.round, d.sessionId]) },
      [
        ...freshSessionFailures(run),
        accepted.length !== reviewers.length &&
          `${reviewers.length - accepted.length} reviewer results were not accepted`,
        reviewNotAccepted(run.world).length > 0 &&
          `the controller recorded no review: ${reviewNotAccepted(run.world).join()}`,
        new Set(reviewers.map((d) => d.round)).size !== 2 && 'reviewers did not run in both rounds',
        schemas.some((s) => typeof s !== 'object') && 'a reviewer schema is missing',
        run.result.finalDecision.type !== 'publish' && `the run ended ${run.result.finalDecision.type}`
      ]
    )
  },

  'reviewer-invalid-result': async (adapter) => {
    const expected: Array<[string, StreamScript | ((value: unknown) => unknown), string]> = [
      [
        'malformed',
        { kind: 'result', value: { reviewResult: { status: 'completed', findings: 'none' } }, noise: true },
        'malformed'
      ],
      ['role mismatch', (v) => withReview(v, { role: 'security-reviewer' }), 'role_mismatch'],
      ['stale head', (v) => withReview(v, { headSha: '0'.repeat(40) }), 'stale'],
      [
        'unknown objective',
        (v) => withReview(v, { objectiveResults: [{ id: 'O9', status: 'MET', evidence: 'x' }] }),
        'rejected'
      ]
    ]
    const observed: Record<string, unknown> = {}
    const failures: Array<string | false> = []
    for (const [label, script, reason] of expected) {
      const run = await runOnAdapter(adapter, makeWorld(), {
        reviewer: (role, round, bound) =>
          role === 'code-reviewer' && round === 1
            ? typeof script === 'function'
              ? { stream: { kind: 'result', value: script(bound) } }
              : { stream: script }
            : undefined
      })
      const records = reviewNotAccepted(run.world)
      observed[label] = { records, decision: run.result.finalDecision.type }
      failures.push(
        !records.includes(`reviewer:${reason}`) &&
          `${label}: the controller did not record no review (${reason}); it recorded ${records.join() || 'nothing'}`,
        run.result.finalDecision.type === 'publish' && `${label}: the run published without an accepted code review`
      )
    }
    return verdict(observed, failures)
  },

  'reviewer-no-result': async (adapter) => {
    // A provider error or an exhausted context reaches the classifier and is recorded as no review; a
    // cancelled dispatch is stopped before it, by the dispatch check, as an infrastructure pause.
    const faults: Array<[string, NonNullable<ReviewerStep>, string]> = [
      [
        'provider error',
        { stream: { kind: 'provider-error', message: 'API Error: 500 internal' } },
        'reviewer:provider_error'
      ],
      ['cancellation', { stream: { kind: 'truncated', value: null }, failureReason: 'signal' }, 'pause:infrastructure'],
      ['context exhaustion', { stream: { kind: 'context-exhausted' } }, 'reviewer:context_exhausted']
    ]
    const observed: Record<string, unknown> = {}
    const failures: Array<string | false> = []
    for (const [label, step, expected] of faults) {
      const run = await runOnAdapter(adapter, makeWorld(), {
        reviewer: (role) => (role === 'code-reviewer' ? step : undefined)
      })
      const records = reviewNotAccepted(run.world)
      const decision = run.result.finalDecision as { type: string; reason?: string }
      const [code] = reviewerDispatches(run).filter((d) => d.role === 'code-reviewer')
      const classified = classifyReviewOutcome(
        {
          cancelled: step.failureReason === 'signal',
          resumed: false,
          terminal: code?.read.terminal ?? null,
          errors: code?.read.errors ?? [],
          hasResult: code !== undefined && code.read.raw !== null,
          raw: code?.read.raw
        },
        bindingFromPrompt('code-reviewer', code?.prompt ?? '')
      )
      observed[label] = {
        records,
        decision,
        classified: classified.kind === 'no_review' ? classified.reason : 'review'
      }
      const seen = expected.startsWith('pause:') ? `pause:${decision.reason}` : records.find((r) => r === expected)
      failures.push(
        seen !== expected &&
          `${label}: expected ${expected}, observed ${records.join() || `${decision.type}:${decision.reason}`}`,
        classified.kind !== 'no_review' && `${label}: the classifier accepted the run as a review`,
        decision.type === 'publish' && `${label}: the run published with no accepted code review`
      )
    }
    return verdict(observed, failures)
  },

  'reviewer-resume-refused': async (adapter) => {
    const refused = (['code-reviewer', 'security'] as const).map((role) =>
      isReviewerResume(role, `${adapter}-earlier-session`)
    )
    const outcome = classifyReviewOutcome(
      { cancelled: false, resumed: true, terminal: 'success', errors: [], hasResult: true, raw: cleanReview() },
      { role: 'code-reviewer', headSha: 'a'.repeat(40), manifestDigest: 'd'.repeat(64), objectiveIds: ['O1'] }
    )
    return verdict(
      {
        refused,
        outcome: outcome.kind === 'no_review' ? outcome.reason : outcome.kind,
        reason: REVIEWER_RESUME_REFUSED_REASON
      },
      [
        refused.some((r) => !r) && 'a reviewer resume was not recognized as one',
        isReviewerResume('developer', 'x') && 'a Developer resume was refused as a reviewer one',
        !(outcome.kind === 'no_review' && outcome.reason === 'resumed') && 'a resumed reviewer result was accepted'
      ]
    )
  },

  'role-context-reviewer': async (adapter) => {
    const world = makeWorld({ roleDoctrine: { reviewer: 'CODE REVIEWER DOCTRINE', security: 'SECURITY DOCTRINE' } })
    const run = await runOnAdapter(adapter, world)
    const failures: Array<string | false> = [...freshSessionFailures(run)]
    const observed: Record<string, unknown> = {}
    for (const d of reviewerDispatches(run)) {
      const role = d.role === 'security' ? 'security' : 'code-reviewer'
      const doctrine = role === 'security' ? 'SECURITY DOCTRINE' : 'CODE REVIEWER DOCTRINE'
      const binding = bindingFromPrompt(role, d.prompt)
      const raw = d.read.raw as { reviewResult?: { manifestDigest?: string } } | null
      observed[role] = { manifestDigest: binding.manifestDigest }
      failures.push(
        !d.prompt.includes(doctrine) && `${role}'s prompt does not carry its role instructions`,
        binding.manifestDigest === '' && `${role}'s prompt names no manifest digest`,
        raw?.reviewResult?.manifestDigest !== binding.manifestDigest && `${role}'s result is bound to another manifest`
      )
    }
    return verdict(observed, failures)
  }
}

function cleanReview(): unknown {
  return {
    reviewResult: {
      schemaVersion: 1,
      status: 'completed',
      role: 'code-reviewer',
      headSha: 'a'.repeat(40),
      manifestDigest: 'd'.repeat(64),
      summary: 'clean',
      findings: [],
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'done.' }]
    }
  }
}

/** The world's own clean review with `fields` replaced — the only way a reviewer script changes a bound result. */
function withReview(value: unknown, fields: Record<string, unknown>): unknown {
  const review = (value as { reviewResult: Record<string, unknown> }).reviewResult
  return { reviewResult: { ...review, ...fields } }
}

// --- host readiness ------------------------------------------------------------

const PROBE_CASES: Record<ContractAdapter, Record<'ready' | 'missing' | 'fails-first-command', SandboxProbeRun>> = {
  claude: {
    ready: claudeProbeRun(SANDBOX_PROBE_MARKER, false),
    missing: claudeProbeRun('bwrap: command not found', true),
    'fails-first-command': claudeProbeRun(
      'apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted): Permission denied',
      true
    )
  },
  codex: {
    ready: { exitCode: 0, stdout: `${SANDBOX_PROBE_MARKER}\n`, stderr: '', timedOut: false },
    missing: { exitCode: 1, stdout: '', stderr: 'error: bwrap not found on PATH', timedOut: false },
    'fails-first-command': {
      exitCode: 1,
      stdout: '',
      stderr: 'bwrap: setting up uid map: Permission denied',
      timedOut: false
    }
  }
}

function claudeProbeRun(text: string, isError: boolean): SandboxProbeRun {
  return {
    exitCode: 0,
    stdout: `${json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'probe', content: text, is_error: isError }] } })}\n`,
    stderr: '',
    timedOut: false
  }
}

async function probe(adapter: ContractAdapter, run: SandboxProbeRun): Promise<SandboxProbeResult> {
  const deps = { platform: 'linux' as const, run: async () => run }
  return adapter === 'claude'
    ? probeAgentSandbox({ agent: 'claude', binaryPath: 'claude', cwd: '/', env: {}, settingsPath: '/s.json' }, deps)
    : probeAgentSandbox(
        {
          agent: 'codex',
          binaryPath: 'codex',
          cwd: '/',
          env: {},
          configToml: 'sandbox_mode = "workspace-write"\n',
          withWritableDirs: (args) => [...args]
        },
        deps
      )
}

const HOST_CHECKS: Record<string, Check> = {
  'host-readiness': async (adapter) => {
    const failures: Array<string | false> = []
    const observed: Record<string, unknown> = {}
    const ready = await probe(adapter, PROBE_CASES[adapter].ready)
    observed.ready = ready
    failures.push(!ready.ok && 'a ready host failed its probe')
    for (const kind of ['missing', 'fails-first-command'] as const) {
      const result = await probe(adapter, PROBE_CASES[adapter][kind])
      observed[kind] = result
      if (result.ok) {
        failures.push(`a host whose sandbox is ${kind} passed its probe`)
        continue
      }
      // The refusal reaches the loop as the handle the dispatcher returns for it.
      const world = makeWorld()
      const run = await runOnAdapter(
        adapter,
        world,
        {},
        {
          dispatchRole: async (role) => {
            world.dispatchCountByRole[role] = (world.dispatchCountByRole[role] ?? 0) + 1
            return {
              exitCode: null,
              durationMs: 1,
              usage: null,
              resumeId: null,
              timedOut: false,
              failureReason: 'refused',
              sandboxProbeRefusal: { agent: adapter, error: result.error }
            }
          }
        }
      )
      const decision = run.result.finalDecision as { type: string; reason?: string }
      failures.push(
        decision.reason !== 'sandbox_refused' &&
          `${kind}: the run ended ${decision.type}/${decision.reason}, not sandbox_refused`,
        turnRecords(world, 1).length > 0 && `${kind}: a turn result was counted on a host that cannot dispatch`,
        (world.dispatchCountByRole.developer ?? 0) !== 1 && `${kind}: the refused dispatch was retried`
      )
    }
    // The adapter's own settings or hooks file absent from where the vendor loads it refuses before spawn.
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-adapter-contract-controls-'))
    try {
      const absent = join(dir, 'absent.json')
      const present = join(dir, 'present.json')
      writeFileSync(present, '{}\n')
      const paths = (p: string) =>
        adapter === 'claude'
          ? { claudeSettingsPath: p, codexHooksPath: null }
          : { claudeSettingsPath: null, codexHooksPath: p }
      observed.absentControls = agentControlsRefusal(adapter, true, paths(absent))
      failures.push(
        agentControlsRefusal(adapter, true, paths(absent)) === null && 'a missing adapter settings file did not refuse',
        agentControlsRefusal(adapter, true, paths(present)) !== null && 'a present adapter settings file refused'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    return verdict(observed, failures)
  }
}

/** Every case's deterministic driver, by case id. */
export const DETERMINISTIC_CHECKS: Record<string, Check> = { ...DEVELOPER_CHECKS, ...REVIEWER_CHECKS, ...HOST_CHECKS }

/** Runs one case on one adapter and session, cleaning the worlds it built. */
export async function runDeterministicCase(
  c: AdapterContractCase,
  adapter: ContractAdapter,
  session: SessionKind
): Promise<CaseVerdict> {
  const check = DETERMINISTIC_CHECKS[c.id]
  if (check === undefined) return { failures: [`no deterministic driver for ${c.id}`], observed: {} }
  try {
    return await check(adapter, session)
  } finally {
    cleanupWorlds()
  }
}
