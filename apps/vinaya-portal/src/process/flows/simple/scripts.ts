import { L } from '../../fixtures/scripts'
import type { ChatLine } from '../../types'

export const backlogChat: ChatLine[] = [
  L('cmd', 'claude'),
  L('out', 'Claude Code · atta-labs/shop · main'),
  L('cmd', '/vinaya planner'),
  L('me', 'Found while working: resume accepts kept work from a previous run. It should refuse it.'),
  L(
    'ag',
    'I read apps/cli/src/commands/resume.ts. One objective, one file, one test. No tranche: it goes to the backlog.'
  ),
  L('me', 'Write it.'),
  L('ag', '#1000 written with its brief, in the backlog. Ready to run.', {
    log: [{ name: 'forge_write.written', detail: 'op=issue.create · #1000' }]
  })
]

/** Simple task's Self-improvement: the report for one task, one finding, opened back in the backlog. */
export const improverIssueChat: ChatLine[] = [
  L('ev', 'report ready · #1000 · 1 task · green first round · 3 problems caught'),
  L('ag', 'I read it. One improvement: resume has no test for a run left half-way.'),
  L('ag', 'Open it as an Issue in the backlog?'),
  L('me', 'Yes, open it.', {
    log: [{ name: 'forge_write.written', detail: 'op=issue.create · #1001' }]
  })
]
