/**
 * The Mission Control wire protocol: what the application WebSocket carries between Studio's server and the page.
 * Imports nothing, so the server endpoint and the browser subscription read the same types, limits and checks.
 *
 * Every message names its protocol version. The server sends a whole snapshot, then whole replacements of changed
 * tasks, each stamped with the snapshot generation it belongs to. A repository is named by an opaque id, never by its
 * local path. The browser may send exactly one message type, `resync`; the protocol has no command channel.
 */

export const PROTOCOL_VERSION = 1

/** The server sends a transport keep-alive this often. It proves the socket is open and nothing about any task. */
export const KEEPALIVE_MS = 20_000
/** The browser treats a socket silent this long (two keep-alives and a grace) as dropped. */
export const SILENCE_LIMIT_MS = 2 * KEEPALIVE_MS + 10_000

/** Reconnect delays in order; the last repeats. Attempts stop at `RECONNECT_MAX_ATTEMPTS` until `retry()`. */
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
export const RECONNECT_MAX_ATTEMPTS = 20

/** Largest message the browser may send, the longest string any task field carries, and the tasks one repository sends. */
export const CLIENT_MESSAGE_MAX_BYTES = 256
export const TEXT_MAX = 500
export const TASKS_PER_REPOSITORY_MAX = 10_000
/** The newest story entries one task sends, and the most reviewer roles one task names. A story is never a full event log. */
export const STORY_PER_TASK_MAX = 50
export const REVIEWER_ROLES_MAX = 16
/** The shape of an opaque story-entry identity: a truncated hash, never a run id, a path or a counter. */
export const STORY_ID_PATTERN = /^[0-9a-f]{24}$/

/** The narration kinds the Log's wording knows; a test holds this list equal to the kernel's. */
export const NARRATION_KIND_NAMES = [
  'starting',
  'working',
  'done',
  'failed',
  'waiting',
  'paused',
  'blocked',
  'information'
] as const
export type NarrationKindName = (typeof NARRATION_KIND_NAMES)[number]

export const TASK_STATE_NAMES = [
  'needs_you',
  'presumed_dead',
  'stopped_itself',
  'needs_a_look',
  'running',
  'ready_to_merge'
] as const
export type TaskStateName = (typeof TASK_STATE_NAMES)[number]

export type FindingCountsView = { blocking: number; nonBlocking: number; unclassified: number }

export type ReviewerView = {
  role: string
  outcome: 'approve' | 'changes_requested' | 'not_reviewed'
  blocking: number | null
  /** `true` when the record gave this reviewer no findings of its own: the round's counts are shared by its reviewers. */
  shared: boolean
}

/**
 * One bounded story entry. `id` is opaque and the same for the same source event across replay and reconnect; `at` is
 * the recorded time, `null` when unknown; `text` is the Log's narration generated from permitted facts only;
 * `personNeeded` is the server's classification; `command` is the next command as recorded for this event.
 */
export type StoryEntryView = {
  id: string
  at: number | null
  kind: NarrationKindName
  text: string
  personNeeded: boolean
  command: string | null
}

export type RoundView = {
  n: number
  startedAt: number | null
  endedAt: number | null
  wallMs: number | null
  outcome: 'green' | 'changes_requested' | 'escalated' | null
  checksGreen: boolean | null
  agents: Record<string, 'working' | 'done' | 'escalated' | 'failed'>
  confidence: number | null
  reviewers: ReviewerView[]
  findings: FindingCountsView | null
}

/** One task, as the page may see it: presentation fields only. Never a gate read, a finding's text or a feed line. */
export type TaskView = {
  task: number
  title: string | null
  state: TaskStateName
  amber: boolean
  reason: string | null
  decision: string | null
  pr: number | null
  nowLine: string
  lastSign: number
  whoActs: string
  command: string | null
  model: string | null
  /** The machine the newest loop record came from; `null` when unknown. A bounded display name, never a path. */
  machine: string | null
  /** The reviewer roles the loop's policy named; empty when none was read. */
  reviewerRoles: string[]
  /** When the current wait for a person began; `null` when the task is not waiting or the time is unknown. */
  attentionSince: number | null
  /** The newest narrated events, oldest first. */
  story: StoryEntryView[]
  rounds: RoundView[]
  tokens: Record<string, { input: number | null; output: number | null; unknownTurns: number }>
}

export type ConnectionName = 'opening' | 'catching-up' | 'live' | 'reconnecting' | 'stopped' | 'unavailable'

export type StatusView = { live: boolean; connection: ConnectionName; reason: string | null }
export type CoverageView = { complete: boolean; limits: { kind: string; detail: string }[] }

/** One repository: an opaque id, its remote's name, the coverage and connection of its picture, and its tasks. */
export type RepositoryView = {
  id: string
  remote: string | null
  status: StatusView
  coverage: CoverageView
  tasks: TaskView[]
}

export type ServerMessage =
  | { v: 1; type: 'snapshot'; generation: number; repositories: RepositoryView[] }
  | { v: 1; type: 'task'; generation: number; repository: string; task: TaskView }
  | { v: 1; type: 'status'; generation: number; repository: string; status: StatusView; coverage: CoverageView }
  | { v: 1; type: 'keepalive' }

export type ClientMessage = { v: 1; type: 'resync' }

const CONNECTIONS: readonly string[] = ['opening', 'catching-up', 'live', 'reconnecting', 'stopped', 'unavailable']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isNullableInt = (v: unknown): boolean => v === null || isInt(v)
const isNullableText = (v: unknown): boolean => v === null || typeof v === 'string'

const isBoundedText = (v: unknown): v is string => typeof v === 'string' && v.length <= TEXT_MAX
const isNullableBoundedText = (v: unknown): boolean => v === null || isBoundedText(v)
const isNullableTime = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)

function isReviewer(v: unknown): v is ReviewerView {
  return (
    isRecord(v) &&
    isBoundedText(v.role) &&
    (v.outcome === 'approve' || v.outcome === 'changes_requested' || v.outcome === 'not_reviewed') &&
    (v.blocking === null || (isInt(v.blocking) && v.blocking >= 0)) &&
    typeof v.shared === 'boolean'
  )
}

function isRound(v: unknown): boolean {
  return isRecord(v) && Array.isArray(v.reviewers) && v.reviewers.every(isReviewer)
}

function isStoryEntry(v: unknown): v is StoryEntryView {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    STORY_ID_PATTERN.test(v.id) &&
    isNullableTime(v.at) &&
    typeof v.kind === 'string' &&
    (NARRATION_KIND_NAMES as readonly string[]).includes(v.kind) &&
    isBoundedText(v.text) &&
    typeof v.personNeeded === 'boolean' &&
    isNullableBoundedText(v.command)
  )
}

function isStatus(v: unknown): v is StatusView {
  return (
    isRecord(v) &&
    typeof v.live === 'boolean' &&
    typeof v.connection === 'string' &&
    CONNECTIONS.includes(v.connection) &&
    isNullableText(v.reason)
  )
}

function isCoverage(v: unknown): v is CoverageView {
  return (
    isRecord(v) &&
    typeof v.complete === 'boolean' &&
    Array.isArray(v.limits) &&
    v.limits.every((l) => isRecord(l) && typeof l.kind === 'string' && typeof l.detail === 'string')
  )
}

function isTask(v: unknown): v is TaskView {
  return (
    isRecord(v) &&
    isInt(v.task) &&
    isNullableText(v.title) &&
    typeof v.state === 'string' &&
    (TASK_STATE_NAMES as readonly string[]).includes(v.state) &&
    typeof v.amber === 'boolean' &&
    isNullableText(v.reason) &&
    isNullableText(v.decision) &&
    isNullableInt(v.pr) &&
    typeof v.nowLine === 'string' &&
    typeof v.lastSign === 'number' &&
    typeof v.whoActs === 'string' &&
    isNullableText(v.command) &&
    isNullableText(v.model) &&
    isNullableBoundedText(v.machine) &&
    Array.isArray(v.reviewerRoles) &&
    v.reviewerRoles.length <= REVIEWER_ROLES_MAX &&
    v.reviewerRoles.every(isBoundedText) &&
    isNullableTime(v.attentionSince) &&
    Array.isArray(v.story) &&
    v.story.length <= STORY_PER_TASK_MAX &&
    v.story.every(isStoryEntry) &&
    Array.isArray(v.rounds) &&
    v.rounds.every(isRound) &&
    isRecord(v.tokens)
  )
}

function isRepository(v: unknown): v is RepositoryView {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    isNullableText(v.remote) &&
    isStatus(v.status) &&
    isCoverage(v.coverage) &&
    Array.isArray(v.tasks) &&
    v.tasks.length <= TASKS_PER_REPOSITORY_MAX &&
    v.tasks.every(isTask)
  )
}

/** Reads one server frame; `null` for anything that is not exactly a version-1 message of a known type. */
export function parseServerMessage(text: string): ServerMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.v !== PROTOCOL_VERSION) return null
  switch (raw.type) {
    case 'keepalive':
      return { v: 1, type: 'keepalive' }
    case 'snapshot':
      return isInt(raw.generation) && Array.isArray(raw.repositories) && raw.repositories.every(isRepository)
        ? { v: 1, type: 'snapshot', generation: raw.generation, repositories: raw.repositories as RepositoryView[] }
        : null
    case 'task':
      return isInt(raw.generation) && typeof raw.repository === 'string' && isTask(raw.task)
        ? { v: 1, type: 'task', generation: raw.generation, repository: raw.repository, task: raw.task }
        : null
    case 'status':
      return isInt(raw.generation) &&
        typeof raw.repository === 'string' &&
        isStatus(raw.status) &&
        isCoverage(raw.coverage)
        ? {
            v: 1,
            type: 'status',
            generation: raw.generation,
            repository: raw.repository,
            status: raw.status,
            coverage: raw.coverage
          }
        : null
    default:
      return null
  }
}

/** Reads one browser frame. The only message the server accepts is `resync`; every other shape is refused. */
export function parseClientMessage(text: string): ClientMessage | null {
  if (text.length > CLIENT_MESSAGE_MAX_BYTES) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.v !== PROTOCOL_VERSION || raw.type !== 'resync') return null
  if (Object.keys(raw).length !== 2) return null
  return { v: 1, type: 'resync' }
}
