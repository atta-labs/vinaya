import { archiveStep, closeTask, foldArchive, T } from '../../fixtures/builders'
import type { Flow, Task, Tranche } from '../../types'
import { hotChat, hotExec, improverReportChat } from './scripts'

const hotTranche: Tranche = {
  name: 'hot',
  tasks: [T(1001, null, 'Fix flaky CLI test', 'apps/cli/test/tmp.test.ts', null, 'main')]
}

/** Hot issue: pair programming with one agent, the same gates. */
export const hotFlow: Flow = foldArchive({
  key: 'hot',
  label: 'Hot issue',
  deploy: 'Deploy a hot issue',
  scope: 'Hot chore, feature or fix',
  tone: 'hot',
  points: ['Pair programming with one agent', 'Same gates', 'Quick and light'],
  tranches: [hotTranche],
  path: ['upstream', 'hot', 'hotmode', 'gates', 'merge', 'archive', 'observed', 'improve'],
  steps: [
    {
      // Hot issue has no Thinking: pairing is executing, so the top bar shows Executing and Improve only
      kind: 'chat',
      stage: 'loop',
      eyebrow: 'Stage 1 · Pairing · hot',
      title: 'Pairing',
      text: '',
      brief: {
        n: 1,
        title: 'Pairing',
        command: 'vinaya hot start --issue 1001',
        does: 'Write one hot Issue, freeze its brief, then fix it live with one agent on its branch',
        output: 'A tested fix on task/issue-1001'
      },
      surface: 'claude',
      lines: hotChat('claude'),
      sceneAfter: { tasks: 1, done: 0, hot: true }
    },
    {
      kind: 'chat',
      stage: 'loop',
      eyebrow: 'Stage 2 · Executing · hot',
      title: 'Executing',
      text: '',
      brief: {
        n: 2,
        title: 'Executing',
        command: 'vinaya hot review --issue 1001',
        does: 'Every gate at commit and push, two reviewers once, the Principal merges',
        output: 'One reviewed pull request, merged by the Principal, the Issue closed'
      },
      surface: 'terminal',
      lines: hotExec
    },
    // folded into Executing: its closing lines type on in the same terminal after the merge
    archiveStep(
      'your hot Issue',
      [{ kind: 'hl', text: '── the Issue closes ──' }, closeTask(hotTranche.tasks[0] as Task, ' · hot')],
      '',
      ''
    ),
    {
      // a chat, not an `improve` step: the report and its finding are the scene's, so no cards under the window
      kind: 'chat',
      stage: 'improve',
      eyebrow: 'Stage 4 · Self-improvement',
      title: 'The Log teaches the process.',
      text: '',
      brief: {
        n: 4,
        title: 'Self-improvement',
        subtitle: 'The Log teaches the process',
        command: 'Automatic',
        does: 'The Log keeps a hot run like any other. The Improver reads it beside the rest and proposes what to change',
        output: 'A new {project} in {tracker}: hot work becomes planned work'
      },
      surface: 'claude',
      lines: improverReportChat
    },
    {
      // back outside Vinaya, but staged as Self-improvement's end: Hot issue has no upstream of its own, so the top
      // bar shows no Upstream crumb that would lead back to Pairing
      kind: 'intro',
      stage: 'improve',
      outro: true,
      eyebrow: 'Upstream · outside Vinaya',
      title: 'A new {project} in {tracker}, from a hot fix.',
      text: 'Three hot fixes in one place are a pattern. The plan goes back to product, the report attached.'
    }
  ]
})
