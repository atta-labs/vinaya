import { L } from '../../fixtures/scripts'
import type { ChatLine, Tranche } from '../../types'

export const architectChat: ChatLine[] = [
  L('cmd', 'claude'),
  L('out', 'Claude Code · atta-labs/shop · main'),
  L('cmd', '/vinaya architect'),
  L('me', 'Checkout v2 is six {project}s in {tracker}. One deploy.'),
  L(
    'ag',
    'I read all six and the code they touch. Charging twice is the root, so the edge, the API and the database go first.'
  ),
  L('ag', 'One milestone, checkout-v2, in three parts: charge once, pay in the apps, support tools.'),
  L('me', 'Support tools last.'),
  L('ag', 'Done. The milestone is open, in three parts. Next, the Planner writes the tasks.', {
    log: [
      { name: 'forge_write.written', detail: 'op=milestone.create · checkout-v2' },
      { name: 'forge_write.written', detail: 'op=branch · milestone/checkout-v2' }
    ]
  })
]

/** One planning conversation for several intents: every tranche written in the same session. */
export const plannerAllChat = (trs: Tranche[]): ChatLine[] => [
  L('cmd', 'claude'),
  L('cmd', '/vinaya planner'),
  L('me', 'Plan every part of the milestone.'),
  L(
    'ag',
    `I read the code first. ${trs.length} parts, ${trs.reduce((n, t) => n + t.tasks.length, 0)} tasks, each with the files it owns and a test it must pass.`
  ),
  L('ag', 'Tasks that touch the same files run one after another; the rest run in parallel.'),
  L('me', 'Approved. Write them.'),
  ...trs.map((tr) =>
    L(
      'ag',
      `${tr.name} · ${tr.tasks.length} tasks written as Issues · #${tr.tasks[0]?.issue}–#${tr.tasks[tr.tasks.length - 1]?.issue}`,
      {
        log: tr.tasks.map((t) => ({ name: 'forge_write.written', detail: `op=issue.create · #${t.issue}` }))
      }
    )
  ),
  L('ag', 'Ready to run.')
]

/** Complex work's Self-improvement: the report is ready, the Improver reads it and opens the biggest change. */
export const improverReportChat: ChatLine[] = [
  L('ev', 'report ready · checkout-v2 · 52 tasks · 19 second rounds · 418 problems caught'),
  L('ag', 'I read it. 3 improvements found.'),
  L('ag', 'The biggest: run the doc gate before push. Open it as a {project} in {tracker}?'),
  L('me', 'Yes, open it.')
]
