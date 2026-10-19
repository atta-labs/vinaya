import { agentName, L } from '../../fixtures/scripts'
import type { Agent, ChatLine } from '../../types'

/** The hot run's identity, minted by `vinaya hot start`. */
export const RUN_ID = 'hot-7f3a'

/**
 * Lines the scene keeps time with, found by their text: when the Issue is written, when `hot start` forks the
 * branch, when each gate runs, when the review reads, when the Principal merges.
 */
export const HOT_MARK = {
  written: 'Hot Issue #1001 written',
  start: 'vinaya hot start',
  started: 'brief frozen',
  fixed: 'own temp dir',
  commit: 'git commit',
  ring0Commit: '31 checks',
  push: 'git push',
  ring0Push: 'Ring 0 green',
  pr: 'Pull request #1472 opened',
  ci: 'merge unblocked',
  review: 'vinaya hot review',
  reviewers: 'in parallel',
  approved: 'APPROVE · APPROVE',
  merged: 'merged by the Principal'
}

/**
 * Hot issue's pairing: the Principal writes the hot Issue with their agent, starts it, and fixes it with them live
 * on its branch. `fixtures/index.ts` reads this one for the hot flow, by agent; the walk renames the agent too.
 */
export const hotChat = (agent: Agent): ChatLine[] => [
  L('cmd', agent),
  L('out', `${agentName(agent)} · atta-labs/shop · main`),
  L('me', 'The CLI test fails one CI run in five. Open it hot.'),
  L('ag', `Two tests share TMPDIR. One objective, one file, a test plan. ${HOT_MARK.written}.`, {
    log: [{ name: 'forge_write.written', detail: 'op=issue.create · #1001 · vinaya/hot', tone: 'hot' }]
  }),
  L('me', 'Start it.'),
  L('cmd', 'vinaya hot start --issue 1001'),
  L('out', `${HOT_MARK.started} · task/issue-1001 from main · worktree ready · run ${RUN_ID}`, {
    log: [
      { name: 'forge_write.written', detail: 'op=branch · task/issue-1001', tone: 'hot' },
      { name: 'run_started', detail: `run=${RUN_ID} · hot`, tone: 'hot' }
    ]
  }),
  L('ag', `Each test now gets its ${HOT_MARK.fixed}. 50 runs locally, 0 failures.`),
  L('me', 'Commit and push.')
]

/** Hot issue's execution: the same gates as any task, review once on demand, the Principal merges. */
export const hotExec: ChatLine[] = [
  L('cmd', 'git commit -m "Fix(cli): temp dir per test"'),
  L('hook', 'pre-commit · biome · typecheck · vinaya check --diff-only'),
  L('ok', '31 checks · 0 failed', {
    log: [{ name: 'gate.summary', detail: 'host=hook ran=31 failed=0' }],
    gates: [1, 0, 0]
  }),
  L('cmd', 'git push -u origin task/issue-1001'),
  L('hook', 'pre-push · vinaya check --all'),
  L('ok', '38 checks · 0 failed · Ring 0 green', {
    log: [{ name: 'gate.summary', detail: 'host=hook ran=38 failed=0' }],
    gates: [2, 0, 0]
  }),
  L('out', 'Pull request #1472 opened · Closes #1001', {
    log: [{ name: 'forge_write.written', detail: 'op=pr.open · #1472' }],
    gates: [2, 1, 0]
  }),
  L('hook', 'CI · Ring 1 · closes-n · surface-scope · test-plan · evidence-fresh'),
  L('ok', '38 checks · 0 failed · merge unblocked', {
    log: [{ name: 'gate.summary', detail: 'host=ci ran=38 failed=0' }],
    gates: [2, 2, 0]
  }),
  L('cmd', 'vinaya hot review --issue 1001'),
  L('ev', 'attempt 1 · code reviewer and security reviewer, in parallel', {
    log: [{ name: 'role_attempt', detail: `run=${RUN_ID} · reviewer ×2 · attempt 1`, tone: 'hot' }]
  }),
  L('ok', 'APPROVE · APPROVE · review gate green', {
    log: [
      { name: 'effect', detail: `hot-${RUN_ID}-1-code-verdict` },
      { name: 'effect', detail: `hot-${RUN_ID}-1-security-verdict` },
      { name: 'run_ended', detail: `run=${RUN_ID} · both verdicts posted`, tone: 'hot' }
    ]
  }),
  L('ok', 'merged by the Principal · #1472 → main', {
    log: [{ name: 'forge_write.written', detail: 'op=pr.merge · #1472' }],
    gates: [2, 2, 2],
    scene: { done: 1 }
  })
]

/** Hot issue's Self-improvement: the hot run's report, read beside the month; one finding, and it is planned. */
export const improverReportChat: ChatLine[] = [
  L('ev', 'report ready · #1001 · hot · 9 min · 1 review attempt · 0 problems caught'),
  L('ag', 'I read it beside the month. The third hot fix in apps/cli tests in 30 days.'),
  L('ag', 'The change: plan it. Every test gets its own temp dir. Open it as a {project} in {tracker}?'),
  L('me', 'Yes, open it.')
]
