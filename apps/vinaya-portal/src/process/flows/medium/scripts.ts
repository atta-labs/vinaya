import { L } from '../../fixtures/scripts'
import type { ChatLine, Task, Tranche } from '../../types'

/** The line that writes the tranche's Issues: the moment the scene's table fills with rows. */
export const WRITTEN = 'tasks written as Issues'

/** Medium work's planning: one Epic, one tranche, three waves set by dependencies. */
export const plannerChat = (tr: Tranche): ChatLine[] => [
  L('cmd', 'claude'),
  L('cmd', '/vinaya planner'),
  L('me', 'Gift cards is one {project} in {tracker}. Plan it.'),
  L(
    'ag',
    `I read the {project} and the code it touches. ${tr.tasks.length} tasks, each with the files it owns and a test it must pass.`
  ),
  L(
    'ag',
    'Three waves: data first, then the API, then the apps. Redeem and Partial balance edit the same file, so one runs after the other.'
  ),
  L('me', 'Approved. Write them.'),
  L(
    'ag',
    `${tr.name} · ${tr.tasks.length} ${WRITTEN} · #${tr.tasks[0]?.issue}–#${tr.tasks[tr.tasks.length - 1]?.issue}`,
    {
      log: tr.tasks.map((t) => ({ name: 'forge_write.written', detail: `op=issue.create · #${t.issue}` }))
    }
  ),
  L('ag', 'No milestone: the tranche lands on main. Ready to run.')
]

/**
 * One task through the loop, in full: the shared one-task script's lines, said
 * without the agent's name, since an `exec` step that carries its own lines is
 * not re-derived for the reader's agent.
 */
const oneTask = (t: Task): ChatLine[] => [
  L('cmd', `vinaya task run ${t.tranche} ${t.n}`, {
    log: [
      { name: 'dev_review_loop.loop_started', detail: `#${t.issue}` },
      { name: 'forge_write.written', detail: 'op=issue.comment · brief' }
    ]
  }),
  L('ev', `#${t.issue} · ${t.title} · the developer works in a sandbox`, {
    log: [{ name: 'dispatch.dispatched', detail: 'role=developer' }]
  }),
  L('out', `  reads and edits ${t.file}, runs the tests`),
  L('ok', '  every check passes before commit and push', {
    log: [
      { name: 'gate.summary', detail: 'host=hook ran=31 failed=0' },
      { name: 'gate.summary', detail: 'host=hook ran=38 failed=0' }
    ],
    gates: [2, 0, 0]
  }),
  L('out', `  pull request opened · closes #${t.issue}`, {
    log: [{ name: 'dev_review_loop.round_started', detail: 'round=1 · pr opened' }],
    gates: [2, 1, 0]
  }),
  L('ok', '  CI green · 38 checks', {
    log: [{ name: 'gate.summary', detail: 'host=ci ran=38 failed=0' }],
    gates: [2, 2, 0]
  }),
  L('ev', '  two fresh reviewers check it · both approve', {
    log: [
      { name: 'dispatch.dispatched', detail: 'role=reviewer ×2' },
      { name: 'dev_review_loop.verdicts_read', detail: 'APPROVE · APPROVE' },
      { name: 'dev_review_loop.round_ended', detail: 'outcome=green' }
    ]
  }),
  L('ok', `  merged · #${t.issue} → ${t.base}`, {
    log: [{ name: 'forge_write.written', detail: 'op=pr.merge' }],
    gates: [2, 2, 1]
  }),
  L('out', `  audit scheduled · #${t.issue} closes with the merge`, {
    log: [{ name: 'forge_write.written', detail: 'op=archive · task_closed', tone: 'retro' }],
    gates: [2, 2, 2]
  })
]

const issues = (ts: Task[]) => ts.map((t) => `#${t.issue}`).join(' ')

/** The marks the scene keeps time with: each names the line that moves it (see `story.ts`). */
export const EXEC_MARK = {
  waveRun: (w: number) => `the Operator runs wave ${w}`,
  waveMerged: (w: number) => `wave ${w} · `,
  waits: 'waits for',
  changes: 'asks for changes',
  secondRound: 'round 2'
} as const

/**
 * Executing, as the Operator runs it: the first task in full, then each wave as
 * it runs in parallel, is tested together on the integration branch and lands
 * on main. Wave 2 shows the dependency (#516 after #515, same file) and one
 * second round.
 */
export const operatorLines = (waves: Task[][], integration: string): ChatLine[] => {
  const [w1 = [], w2 = [], w3 = []] = waves
  const first = w1[0]
  const after = w2.find((t) => t.issue === 516)
  const before = w2.find((t) => t.issue === 515)
  const run = (w: number, ts: Task[]): ChatLine => ({
    kind: 'ev',
    text: `${EXEC_MARK.waveRun(w)} · ${ts.length} tasks in parallel`,
    effect: { log: ts.map((t) => ({ name: 'dev_review_loop.loop_started', detail: `#${t.issue}` })) }
  })
  const land = (w: number, ts: Task[]): ChatLine => ({
    kind: 'ok',
    text: `${EXEC_MARK.waveMerged(w)}${ts.length} of ${ts.length} reviewed · tested together · merged → main`,
    effect: {
      log: [
        ...ts.map((t) => ({ name: 'forge_write.written', detail: `op=merge · #${t.issue} → ${integration}` })),
        { name: 'forge_write.written', detail: `op=merge · ${integration} → main` }
      ]
    }
  })
  return [
    ...(first ? oneTask(first) : []),
    { kind: 'hl', text: `── wave 1 · ${issues(w1)}`, effect: { gates: [0, 0, 0] } },
    run(1, w1),
    land(1, w1),
    { kind: 'hl', text: `── wave 2 · ${issues(w2)}` },
    run(2, w2),
    L('out', `  #${after?.issue} ${EXEC_MARK.waits} #${before?.issue} · both edit ${before?.file}`),
    L('hook', `✗ #${before?.issue} · round 1 · a reviewer ${EXEC_MARK.changes}`, {
      log: [{ name: 'dev_review_loop.verdicts_read', detail: `#${before?.issue} · CHANGES · APPROVE` }]
    }),
    L('ok', `#${before?.issue} · ${EXEC_MARK.secondRound} · both approve · #${after?.issue} starts`, {
      log: [{ name: 'dev_review_loop.round_ended', detail: `#${before?.issue} · round=2 · outcome=green` }]
    }),
    land(2, w2),
    { kind: 'hl', text: `── wave 3 · ${issues(w3)}` },
    run(3, w3),
    land(3, w3)
  ]
}

/** Medium work's Self-improvement: the report is ready, the Improver reads it and opens the biggest change. */
export const improverReportChat: ChatLine[] = [
  L('ev', 'report ready · gift-cards · 12 tasks · 3 second rounds · 31% agent time idle'),
  L('ag', 'I read it. 3 improvements found.'),
  L(
    'ag',
    'The biggest: start each task when its own dependencies merge, not its wave. Open it as a {project} in {tracker}?'
  ),
  L('me', 'Yes, open it.')
]
