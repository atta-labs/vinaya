import type { EscalationRecord } from '@attalabs/aeg-core'
import {
  bindPauseToPullRequest,
  readPauseState,
  writePauseState,
  type PauseCommentPostResult
} from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import type { HandoffDeps } from '../executing/handoff'

// The handoff's writers and posts for a test: the pause record is the real one in the run's own folder,
// the escalation record and the forge posts are recorded in the order they happened and reach nothing.

export interface RecordedHandoff {
  deps: HandoffDeps
  /** What the handoff did, in order: `escalation:<reason>`, `pause-state:<reason>`, `comment:<pr|issue>:<reason>`. */
  calls: string[]
  /** The Log events the handoff wrote. */
  logged: unknown[]
  /** What the next pause comment reports; absent means it landed on the first attempt. */
  postResult?: PauseCommentPostResult
}

export function recordedHandoff(): RecordedHandoff {
  const calls: string[] = []
  const logged: unknown[] = []
  const recorded: RecordedHandoff = {
    calls,
    logged,
    deps: {
      writeEscalationRecord: (facts) => {
        calls.push(`escalation:${facts.reason}`)
        return {
          escalationId: `${facts.task}-${facts.round}-${facts.head}`,
          rulingOrdinal: facts.rulingOrdinal
        } as unknown as EscalationRecord
      },
      writePauseState: (root, state) => {
        calls.push(`pause-state:${state.reason}`)
        writePauseState(root, state)
      },
      readPauseState,
      postPauseComment: (_task, _round, _head, _pr, reason) => {
        calls.push(`comment:pr:${reason}`)
        return recorded.postResult ?? { attempts: 1, posted: true }
      },
      postIssuePauseComment: (_task, _branch, _round, reason) => {
        calls.push(`comment:issue:${reason}`)
        return recorded.postResult ?? { attempts: 1, posted: true }
      },
      bindPauseToPullRequest,
      log: (event) => void logged.push(event)
    }
  }
  return recorded
}
