import { archiveStep, closeTranche, foldArchive, improveStep, intro, T } from '../../fixtures/builders'
import type { ChatLine, Flow, Tranche } from '../../types'
import { architectChat, improverReportChat, plannerAllChat } from './scripts'

/* Complex work: one milestone, checkout-v2, in three parts. Each part is a tranche;
   its tasks span the six products the deploy touches. */
/** The first task of the first tranche: the one the demo's windows follow. */
export const idempotencyTask = T(418, 1, 'Idempotency key', 'edge/webhook.ts', 'checkout-v2/1', 'milestone/checkout-v2')

export const checkout1: Tranche = {
  name: 'checkout-v2/1',
  intent: 'Charge once: the edge, the API and the database. Milestone checkout-v2.',
  tasks: [
    idempotencyTask,
    T(419, 2, 'Edge retry queue', 'edge/retry.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(420, 3, 'Signed webhook check', 'edge/verify.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(421, 4, 'Rate limit per merchant', 'edge/limits.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(422, 5, 'Edge price cache', 'edge/prices.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(423, 6, 'Bot filter on checkout', 'edge/bots.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(424, 7, 'Edge logs to the Log', 'edge/logs.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(425, 8, 'Block replays', 'api/charge.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(426, 9, 'Charge states', 'api/states.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(427, 10, 'Refund endpoint', 'api/refund.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(428, 11, 'Partial captures', 'api/capture.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(429, 12, 'Currency rounding', 'api/money.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(430, 13, 'Webhook fan-out', 'api/webhooks.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(431, 14, 'Charge audit trail', 'api/audit.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(432, 15, 'API error codes', 'api/errors.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(433, 16, 'Ledger table', 'db/ledger.sql', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(434, 17, 'Idempotency index', 'db/idem.sql', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(435, 18, 'Receipts table', 'db/receipts.sql', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(436, 19, 'Zero-downtime migration', 'db/migrate.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(437, 20, 'Ledger backfill', 'db/backfill.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(438, 21, 'Read replica', 'db/replica.ts', 'checkout-v2/1', 'milestone/checkout-v2'),
    T(439, 22, 'Archive old charges', 'db/archive.ts', 'checkout-v2/1', 'milestone/checkout-v2')
  ]
}
const checkout2: Tranche = {
  name: 'checkout-v2/2',
  intent: 'Pay in the apps: mobile and desktop. Milestone checkout-v2.',
  tasks: [
    T(440, 1, 'Mobile one-tap pay', 'mobile/Pay.tsx', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(441, 2, 'Mobile receipts', 'mobile/Receipt.tsx', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(442, 3, 'Apple Pay sheet', 'mobile/ApplePay.tsx', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(443, 4, 'Google Pay sheet', 'mobile/GooglePay.tsx', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(444, 5, 'Saved cards on mobile', 'mobile/Cards.tsx', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(445, 6, 'Offline retry', 'mobile/retry.ts', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(446, 7, 'Mobile payment errors', 'mobile/Errors.tsx', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(447, 8, 'Push on refund', 'mobile/push.ts', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(448, 9, 'Checkout analytics', 'mobile/analytics.ts', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(449, 10, 'Desktop checkout', 'desktop/checkout.ts', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(450, 11, 'Desktop saved cards', 'desktop/cards.ts', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(451, 12, 'Desktop receipts', 'desktop/receipts.ts', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(452, 13, 'Card form', 'desktop/CardForm.tsx', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(453, 14, '3-D Secure window', 'desktop/threeds.ts', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(454, 15, 'Desktop refunds', 'desktop/refunds.ts', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(455, 16, 'Auto-update gate', 'desktop/update.ts', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(456, 17, 'Desktop error states', 'desktop/errors.ts', 'checkout-v2/2', 'milestone/checkout-v2'),
    T(457, 18, 'Checkout shortcuts', 'desktop/keys.ts', 'checkout-v2/2', 'milestone/checkout-v2')
  ]
}

const checkout3: Tranche = {
  name: 'checkout-v2/3',
  intent: 'Support tools: the admin. Milestone checkout-v2.',
  tasks: [
    T(458, 1, 'Refunds view', 'admin/refunds.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(459, 2, 'Ledger search', 'admin/ledger.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(460, 3, 'Dispute notes', 'admin/disputes.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(461, 4, 'Charge timeline', 'admin/timeline.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(462, 5, 'Refund approvals', 'admin/approvals.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(463, 6, 'Customer lookup', 'admin/customers.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(464, 7, 'Ledger export', 'admin/export.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(465, 8, 'Fraud flags', 'admin/fraud.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(466, 9, 'Payout report', 'admin/payouts.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(467, 10, 'Support macros', 'admin/macros.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(468, 11, 'Admin roles', 'admin/roles.tsx', 'checkout-v2/3', 'milestone/checkout-v2'),
    T(469, 12, 'Audit log view', 'admin/audit.tsx', 'checkout-v2/3', 'milestone/checkout-v2')
  ]
}

/** A whole tranche's Issues closed in one line: what the Archivist reports when a part has many. */
const closeTasks = (tr: Tranche): ChatLine => ({
  kind: 'ok',
  text: `${tr.name} · ${tr.tasks.length} Issues closed · #${tr.tasks[0]?.issue}–#${tr.tasks[tr.tasks.length - 1]?.issue}`,
  effect: {
    log: tr.tasks.map((t) => ({
      name: 'forge_write.written',
      detail: `op=archive · #${t.issue}`,
      tone: 'retro' as const
    }))
  }
})

/** Complex work: several features or projects, one target, one deploy. */
export const complexFlow: Flow = foldArchive({
  key: 'feature',
  label: 'Complex work',
  deploy: 'Deploy complex work',
  scope: 'Multiple projects or features',
  tone: 'think',
  points: ['Several features or projects', 'One target, one deploy', 'Built in parallel', 'Proven to work together'],
  tranches: [checkout1, checkout2, checkout3],
  path: ['upstream', 'architect', 'planner', 'loop', 'gates', 'merge', 'archive', 'observed', 'improve'],
  steps: [
    intro({
      title: 'One target,\nsix {project}s in {tracker}.',
      text: 'Six features across mobile, desktop, edge, API, database and admin. One deploy ships them all.'
    }),
    {
      kind: 'chat',
      stage: 'architect',
      eyebrow: 'Stage 1 · Thinking · Architect',
      title: 'Thinking',
      text: '',
      brief: {
        n: 1,
        title: 'Thinking',
        command: '/vinaya architect',
        does: 'Turn the six {project}s into one milestone',
        output: 'One milestone in three parts'
      },
      surface: 'claude',
      lines: architectChat,
      sceneAfter: { milestone: true }
    },
    {
      kind: 'chat',
      stage: 'planner',
      eyebrow: 'Stage 1 · Thinking · Planner',
      title: 'Planning',
      text: '',
      brief: {
        n: 1,
        title: 'Planning',
        command: '/vinaya planner',
        does: 'Write every task as an Issue an agent can run',
        output: '52 tasks in 3 tranches'
      },
      surface: 'claude',
      lines: plannerAllChat([checkout1, checkout2, checkout3])
    },
    {
      kind: 'exec',
      stage: 'loop',
      eyebrow: 'Stage 2 · Executing',
      title: 'Executing',
      text: '',
      brief: {
        n: 2,
        title: 'Executing',
        command: '/vinaya operator',
        does: 'Run the tasks in parallel: an agent builds, two fresh reviewers check, every gate runs, closure on every merge',
        output: '52 reviewed pull requests, merged by the Principal, the milestone closed'
      },
      surface: 'terminal',
      // Every task of both tranches, in one run: the Operator dispatches them in waves.
      tranche: { name: null, tasks: [...checkout1.tasks, ...checkout2.tasks, ...checkout3.tasks] },
      // one task in full, then each tranche as one dispatch line and one merge line: readable at fifty-two
      logFull: 1
    },
    {
      ...archiveStep(
        'your milestone',
        [
          { kind: 'hl', text: '── the milestone closes ──' },
          closeTasks(checkout1),
          closeTranche(checkout1),
          closeTasks(checkout2),
          closeTranche(checkout2),
          closeTasks(checkout3),
          closeTranche(checkout3),
          {
            kind: 'ok',
            text: 'milestone checkout-v2 done · 3 parts · 52 tasks',
            effect: {
              log: [{ name: 'forge_write.written', detail: 'op=milestone.close · checkout-v2', tone: 'retro' }]
            }
          }
        ],
        '',
        ''
      ),
      brief: {
        n: 3,
        title: 'Retrospecting',
        command: 'Automatic',
        output: 'Pull requests merged, Issues closed, milestone done'
      }
    },
    {
      ...improveStep(['34 min', '6 of 6', '4']),
      lines: improverReportChat,
      brief: {
        n: 4,
        title: 'Self-improvement',
        subtitle: 'The Log teaches the process',
        command: 'Automatic',
        does: 'The Log turns every run into a report. The Improver reads it and proposes what to change',
        output: 'A new {project} in {tracker}, with its report'
      }
    },
    {
      kind: 'intro',
      stage: 'upstream',
      outro: true,
      eyebrow: 'Upstream · outside Vinaya',
      title: 'A new {project} in {tracker}, with its report.',
      text: 'The change the Log asked for goes back to product, the report attached. The next deploy starts from here.'
    }
  ]
})
