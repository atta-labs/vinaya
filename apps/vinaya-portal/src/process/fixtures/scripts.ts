import type { Agent, ChatLine, Task } from '../types'

/** One line of a chat or terminal script. The flow-specific scripts live in `../flows/<flow>/scripts.ts`. */
export const L = (kind: ChatLine['kind'], text: string, effect?: ChatLine['effect']): ChatLine => ({
  kind,
  text,
  effect
})

export const agentName = (a: Agent) => (a === 'codex' ? 'Codex' : 'Claude Code')

/** One task through the loop, in plain words: the reusable script. Every line keeps its Log events and gate state. */
export const execScript = (t: Task, agent: Agent): ChatLine[] => [
  L(
    'cmd',
    t.tranche
      ? `vinaya task run ${t.tranche} ${t.n} --agent ${agent}`
      : `vinaya task run --issue ${t.issue} --agent ${agent}`,
    {
      log: [
        { name: 'dev_review_loop.loop_started', detail: `#${t.issue}` },
        { name: 'forge_write.written', detail: 'op=issue.comment · brief' }
      ]
    }
  ),
  L('ev', `#${t.issue} · ${t.title} · the developer works in a sandbox (${agent})`, {
    log: [{ name: 'dispatch.dispatched', detail: 'role=developer' }],
    scene: { orbit: true }
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
    ],
    scene: { orbit: false }
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

export const improverChat: ChatLine[] = [
  L('ev', 'the Log writes the report · every run of this deploy'),
  L('ag', 'I read the report. Three changes would cut the extra rounds.'),
  L('ag', 'Shall I open the first as a {project} in {tracker}?'),
  L('me', 'Yes, open it.')
]
