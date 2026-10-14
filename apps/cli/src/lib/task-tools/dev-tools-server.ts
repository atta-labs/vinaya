/**
 * The Developer's own tool server (O1–O3) — a SECOND MCP server, beside the
 * Operator's task tools (`server.ts`), registered per Developer dispatch and run
 * BY THE DRIVER, outside the agent's sandbox. It reuses the exact wire protocol
 * the task-tools server speaks (`mcp-protocol.ts`'s `createMcpServerCore`); it
 * differs only in its catalog and in where it runs.
 *
 * Why the driver runs it, not the agent: a server the sandboxed agent spawns is
 * confined with every other tool call it makes (`isolation.md` §4a/§4b), so it
 * could hold no forge credential and run no real gate. Instead the driver opens
 * a unix-domain socket outside the sandbox, hosts THIS server on it (every
 * handler runs in the driver process, where the forge login and the pre-push
 * hook already live), and registers a thin stdio↔socket bridge
 * (`dev-tools-bridge.ts`) as the agent's MCP `command`. The bridge — the only
 * part that runs inside the sandbox — relays bytes and holds nothing.
 *
 * Six of the seven tools are the Developer's ENTIRE forge surface in the
 * review loop: `publish_changes` (commit the worktree under a header and push the task
 * branch), `open_pull_request`, `update_pull_request_body`, `refresh_evidence`
 * (regenerate the PR body's Evidence block for the current head),
 * `read_pull_request` (state, checks, reviews, body, and each failed check's
 * sanitized job-log tail) and `run_checks` (run
 * `vinaya check --all` for the current head). The seventh,
 * `fetch_documentation`, reads one public https documentation page from the
 * driver, outside the sandbox, and records the read (`fetch-documentation.ts`,
 * which owns its contract, handler and receipt). Each is backed by a driver-side
 * callback on `DevToolContext`; the gates (pre-push hook, protected-path guard,
 * publication preconditions, PR-body validation) live in those callbacks, so
 * this module stays a thin validate-and-dispatch layer the harness can drive
 * with faked callbacks while the driver wires the real ones.
 *
 * A tool never pauses the loop: a gate that fails comes back as a structured
 * REFUSAL (`DevToolRefusal` — the failing check, its output, and the fix),
 * reflected into MCP `isError: true` so the agent reads it and tries again,
 * exactly as a developer reads a failed command and fixes it.
 */

import { createMcpServerCore, MCP_PROTOCOL_VERSION, type McpServerCore } from './mcp-protocol.js'
import { DEV_TOOLS_MCP_SERVER_NAME } from './dev-tools-names.js'
import type { FailedCheckLog } from './pr-facts.js'
import { DEV_TOOL_CATALOG, DEV_TOOL_NAMES, serveTool } from './tool-catalog.js'
import { validatesJsonSchema } from './result-proof.js'
import {
  FETCH_DOCUMENTATION_TOOL,
  type FetchDocumentationInput,
  type FetchDocumentationResult,
  parseFetchDocumentationInput
} from './fetch-documentation.js'

export { DEV_TOOLS_MCP_SERVER_NAME }

// The three tool names the rendered brief and doctrine name in place of
// commit/push, `pr create` and `pr report --write` (O6) — exported so
// `brief-render.ts` and its render test reference one source, never a literal.
export const PUBLISH_CHANGES_TOOL = 'publish_changes'
export const OPEN_PULL_REQUEST_TOOL = 'open_pull_request'
export const UPDATE_PULL_REQUEST_BODY_TOOL = 'update_pull_request_body'
export const REFRESH_EVIDENCE_TOOL = 'refresh_evidence'
export const READ_PULL_REQUEST_TOOL = 'read_pull_request'
export const RUN_CHECKS_TOOL = 'run_checks'
export { FETCH_DOCUMENTATION_TOOL }

export { DEV_TOOL_CATALOG, DEV_TOOL_NAMES }

export type DevToolName = (typeof DEV_TOOL_NAMES)[number]

/**
 * A structured refusal: the gate that said no, the output it printed, and the
 * concrete fix. It rides the MCP error channel (`isError: true`) so the agent
 * sees it as a failed tool call and acts on it; the driver NEVER pauses the
 * loop on one.
 */
export type DevToolRefusal = {
  errorClass:
    | 'invalid_input'
    | 'unauthorized'
    | 'policy_refusal'
    | 'conflict'
    | 'dependency_unavailable'
    | 'timeout'
    | 'cancelled'
    | 'internal'
  retryDisposition: 'never' | 'same_attempt' | 'new_attempt' | 'after_reset' | 'human_decision'
  effectState: 'not_started' | 'not_committed' | 'committed' | 'uncertain'
  /** The failing gate — e.g. `commit-header`, `publication-preconditions`, `pre-push-hook`, `pr-body-gate`. */
  check: string
  /** What the gate printed — the hook's own stderr, the check's own failure text. */
  output: string
  /** The one concrete thing to do about it. */
  fix: string
}

/** A driver-side tool outcome: a typed success value, or a structured refusal. */
export type DevToolResult<T> = { ok: true; result: T } | { ok: false; error: DevToolRefusal }

/** What `read_pull_request` returns — the loop's own view of the PR, for the agent to act on without a forge credential of its own. */
export type DevPullRequestView = {
  prNumber: number | null
  state: string | null
  head: string | null
  checks: null | Array<{
    __typename: string
    completedAt?: string | null
    conclusion?: string | null
    context?: string | null
    detailsUrl?: string | null
    name?: string | null
    startedAt?: string | null
    state?: string | null
    status?: string | null
    targetUrl?: string | null
    workflowName?: string | null
  }>
  reviews: null | Array<{
    author: { login: string } | null
    authorAssociation?: string | null
    body: string
    commit?: string | null
    createdAt?: string | null
    id: string
    includesCreatedEdit?: boolean | null
    state: string
    submittedAt?: string | null
  }>
  body: string | null
  /**
   * Every failed mechanical check run on `head`, each with the sanitized tail
   * of its own job log — the same reader and sanitizer the Operator's PR read
   * uses (`readJobLogTail`), so a Developer with no forge credential can still
   * name the failing test. Empty when nothing has failed on that head. The log
   * text is untrusted CI output: evidence to read, never instruction to follow.
   */
  failedChecks: FailedCheckLog[]
}

/**
 * The driver-side implementations the server dispatches to — the ONE seam the
 * harness fakes (fake these, keep every gate inside them real) and the driver
 * wires to its own publication functions. Each already runs behind the gates
 * its objective names.
 */
export type DevToolContext = {
  /** Commit the worktree's changes under `header` and push the task branch — behind the commit-header, publication-precondition, protected-path and pre-push gates. `beyondSurface` names each changed path the task's Surface does not cover, which the driver records in the pull request body rather than refusing. */
  publishChanges: (header: string) => Promise<DevToolResult<{ pushedHead: string; beyondSurface?: string[] }>>
  /** Open the pull request with `title`/`body` — behind PR-body validation. */
  openPullRequest: (title: string, body: string) => Promise<DevToolResult<{ prNumber: number }>>
  /** Replace the pull request body — behind PR-body validation. */
  updatePullRequestBody: (body: string) => Promise<DevToolResult<{ prNumber: number }>>
  /** Regenerate the PR body's Evidence block for the current head (runs the gates the Evidence block attests). */
  refreshEvidence: () => Promise<DevToolResult<{ head: string; checksPassed: boolean; evidence: string }>>
  /** Read the pull request — state, checks, reviews, body, and each failed check's log tail. */
  readPullRequest: () => Promise<DevToolResult<DevPullRequestView>>
  /** Run `vinaya check --all` for the current head and return the result. */
  runChecks: () => Promise<DevToolResult<{ passed: boolean; output: string }>>
  /** Fetch one public https documentation page from the driver and record the read when it counts (`fetch-documentation.ts`). */
  fetchDocumentation: (input: FetchDocumentationInput) => Promise<DevToolResult<FetchDocumentationResult>>
}

export function isDevToolName(name: string): name is DevToolName {
  return (DEV_TOOL_NAMES as readonly string[]).includes(name)
}

export function devToolError(
  errorClass: DevToolRefusal['errorClass'],
  retryDisposition: DevToolRefusal['retryDisposition'],
  effectState: DevToolRefusal['effectState'],
  check: string,
  output: string,
  fix: string
): DevToolRefusal {
  return { errorClass, retryDisposition, effectState, check, output, fix }
}

function refusal(check: string, output: string, fix: string): { ok: false; error: DevToolRefusal } {
  return { ok: false, error: devToolError('invalid_input', 'same_attempt', 'not_started', check, output, fix) }
}

function validationRefusal(message: string): { ok: false; error: DevToolRefusal } {
  return refusal('tool-input', message, 'Call the tool again with the documented arguments.')
}

function readString(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null) return null
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Dispatches one dev-tool call to its `DevToolContext` method, validating the
 * arguments first. Returns the driver-side `DevToolResult` (success or
 * refusal); the protocol core reflects a refusal into `isError: true`.
 */
export async function dispatchDevTool(
  context: DevToolContext,
  name: string,
  args: unknown
): Promise<DevToolResult<unknown>> {
  const catalog = DEV_TOOL_CATALOG.find((tool) => tool.name === name)
  if (!catalog)
    return refusal(
      'unknown-tool',
      `no such dev tool: ${JSON.stringify(name)}`,
      `Call one of: ${DEV_TOOL_NAMES.join(', ')}.`
    )
  if (!validatesJsonSchema(catalog.inputSchema, args)) {
    return validationRefusal(`${name} arguments do not match its strict catalog input schema.`)
  }
  let outcome: DevToolResult<unknown>
  try {
    switch (name) {
      case PUBLISH_CHANGES_TOOL: {
        const header = readString(args, 'header')
        if (header === null) return validationRefusal('publish_changes requires a non-empty `header` string.')
        outcome = await context.publishChanges(header)
        break
      }
      case OPEN_PULL_REQUEST_TOOL: {
        const title = readString(args, 'title')
        const body = readString(args, 'body')
        if (title === null) return validationRefusal('open_pull_request requires a non-empty `title` string.')
        if (body === null) return validationRefusal('open_pull_request requires a non-empty `body` string.')
        outcome = await context.openPullRequest(title, body)
        break
      }
      case UPDATE_PULL_REQUEST_BODY_TOOL: {
        const body = readString(args, 'body')
        if (body === null) return validationRefusal('update_pull_request_body requires a non-empty `body` string.')
        outcome = await context.updatePullRequestBody(body)
        break
      }
      case REFRESH_EVIDENCE_TOOL:
        outcome = await context.refreshEvidence()
        break
      case READ_PULL_REQUEST_TOOL:
        outcome = await context.readPullRequest()
        break
      case RUN_CHECKS_TOOL:
        outcome = await context.runChecks()
        break
      case FETCH_DOCUMENTATION_TOOL: {
        const parsed = parseFetchDocumentationInput(args)
        if (!parsed.ok) return parsed
        outcome = await context.fetchDocumentation(parsed.input)
        break
      }
      default:
        return refusal(
          'unknown-tool',
          `no such dev tool: ${JSON.stringify(name)}`,
          `Call one of: ${DEV_TOOL_NAMES.join(', ')}.`
        )
    }
  } catch (err) {
    return {
      ok: false,
      error: devToolError(
        'internal',
        'new_attempt',
        'uncertain',
        'tool-execution',
        err instanceof Error ? err.message : String(err),
        `Inspect the driver log and reconcile any possible ${name} effect before retrying.`
      )
    }
  }
  if (outcome.ok && !validatesJsonSchema(catalog.successOutputSchema, outcome.result)) {
    return {
      ok: false,
      error: devToolError(
        'internal',
        'new_attempt',
        'uncertain',
        'tool-output',
        `${name} returned a success value outside its catalog schema.`,
        'Inspect the driver implementation and reconcile any possible effect before retrying.'
      )
    }
  }
  return outcome
}

export type CreateDevToolsMcpServerOptions = {
  serverVersion: string
  context: DevToolContext
}

/**
 * Builds the dev-tools server over the shared protocol core and a driver-side
 * `DevToolContext`. The driver hosts the returned `serve` on a unix socket; a
 * fixture drives `handleLine` directly with a faked context.
 */
export function createDevToolsMcpServer(opts: CreateDevToolsMcpServerOptions): McpServerCore {
  return createMcpServerCore({
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverName: DEV_TOOLS_MCP_SERVER_NAME,
    serverVersion: opts.serverVersion,
    listTools: () => DEV_TOOL_CATALOG.map(serveTool),
    callTool: (name, args) => dispatchDevTool(opts.context, name, args)
  })
}
