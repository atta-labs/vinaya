import { createHash } from 'node:crypto'
import type {
  FeedLine,
  FindingCounts,
  RoundPicture,
  TaskPicture
} from '../../../../harness/processes/vinaya-strict/tools/mission-control/picture.ts'
import type {
  CoverageView,
  FindingCountsView,
  RepositoryView,
  RoundView,
  StatusView,
  StoryEntryView,
  TaskView
} from '../lib/mission-control-protocol.ts'
import {
  REVIEWER_ROLES_MAX,
  STORY_PER_TASK_MAX,
  TASKS_PER_REPOSITORY_MAX,
  TEXT_MAX
} from '../lib/mission-control-protocol.ts'
import type { RepositorySnapshot } from './picture-service.ts'

/**
 * The browser-safe projection: an explicit allowlist of presentation fields, built field by field. The internal task
 * picture is never spread onto the wire — it carries gate reads (recorded payloads), the feed's narration, machine
 * names and loop identities. A field reaches the page only by being named below.
 */

function text(value: string): string {
  return value.length > TEXT_MAX ? `${value.slice(0, TEXT_MAX - 3)}...` : value
}
const nullableText = (value: string | null): string | null => (value === null ? null : text(value))

function counts(value: FindingCounts | null): FindingCountsView | null {
  return value === null
    ? null
    : { blocking: value.blocking, nonBlocking: value.nonBlocking, unclassified: value.unclassified }
}

function roundView(round: RoundPicture): RoundView {
  return {
    n: round.n,
    startedAt: round.startedAt,
    endedAt: round.endedAt,
    wallMs: round.wallMs,
    outcome: round.outcome,
    checksGreen: round.checksGreen,
    agents: { ...round.agents },
    confidence: round.confidence?.value ?? null,
    reviewers: round.reviewers.map((r) => ({
      role: text(r.role),
      outcome: r.outcome,
      blocking: r.blocking,
      shared: r.shared
    })),
    findings: counts(round.findings)
  }
}

/** The opaque identity of a story entry: a hash of the source event's own identity, the same on every replay and reconnect. */
export function storyId(identity: string): string {
  return createHash('sha256').update(`vinaya-studio:story:${identity}`).digest('hex').slice(0, 24)
}

function storyEntry(line: FeedLine): StoryEntryView {
  return {
    id: storyId(line.id),
    at: line.at > 0 ? line.at : null,
    kind: line.kind,
    text: text(line.text),
    personNeeded: line.personNeeded,
    command: nullableText(line.command)
  }
}

export function taskView(task: TaskPicture): TaskView {
  const tokens: TaskView['tokens'] = {}
  for (const [role, t] of Object.entries(task.tokens)) {
    tokens[role] = { input: t.input, output: t.output, unknownTurns: t.unknownTurns }
  }
  return {
    task: task.task,
    title: nullableText(task.title),
    state: task.state,
    amber: task.amber,
    reason: nullableText(task.reason),
    decision: nullableText(task.decision),
    pr: task.pr,
    nowLine: text(task.nowLine),
    lastSign: task.lastSign,
    whoActs: text(task.whoActs),
    command: nullableText(task.command),
    model: nullableText(task.model),
    machine: nullableText(task.machine),
    reviewerRoles: task.reviewerRoles.slice(0, REVIEWER_ROLES_MAX).map(text),
    attentionSince: task.attentionSince !== null && task.attentionSince > 0 ? task.attentionSince : null,
    story: task.feed.slice(-STORY_PER_TASK_MAX).map(storyEntry),
    rounds: task.rounds.map(roundView),
    tokens
  }
}

export function statusView(snapshot: RepositorySnapshot): StatusView {
  const { live, connection, reason } = snapshot.status
  return { live, connection, reason: nullableText(reason) }
}

export function coverageView(snapshot: RepositorySnapshot): CoverageView {
  return {
    complete: snapshot.coverage.complete,
    limits: snapshot.coverage.limits.map((l) => ({ kind: l.kind, detail: text(l.detail) }))
  }
}

/** One repository under its opaque wire id. The local root path never appears. */
export function repositoryView(id: string, snapshot: RepositorySnapshot): RepositoryView {
  return {
    id,
    remote: snapshot.remote,
    status: statusView(snapshot),
    coverage: coverageView(snapshot),
    tasks: snapshot.picture.tasks.slice(0, TASKS_PER_REPOSITORY_MAX).map(taskView)
  }
}
