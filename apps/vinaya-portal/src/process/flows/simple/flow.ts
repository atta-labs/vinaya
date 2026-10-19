import { archiveStep, closeTask, execStep, foldArchive, improveStep, T } from '../../fixtures/builders'
import type { Flow, Task, Tranche } from '../../types'
import { backlogChat, improverIssueChat } from './scripts'

const backlog: Tranche = {
  name: null,
  tasks: [T(1000, null, 'Resume refuses kept work', 'apps/cli/src/commands/resume.ts', null, 'main')]
}

/** Simple task: one small task or feature, recorded as one backlog Issue. */
export const simpleFlow: Flow = foldArchive({
  key: 'backlog',
  label: 'Simple task',
  deploy: 'Deploy a backlog issue',
  scope: 'Simple chore, feature, fix or refactor',
  tone: 'think',
  points: ['One small task or feature', 'Recorded as an Issue', 'Integration branch if you want', 'Quick and light'],
  tranches: [backlog],
  path: ['upstream', 'planner', 'loop', 'gates', 'merge', 'archive', 'observed', 'improve'],
  steps: [
    {
      kind: 'chat',
      stage: 'planner',
      eyebrow: 'Stage 1 · Thinking',
      title: 'The Planner writes one backlog Issue.',
      text: 'Lighter planning, no tranche. Still a brief, still dispatchable by the same loop.',
      brief: {
        n: 1,
        title: 'Planning',
        command: '/vinaya planner',
        does: 'Write the small task as one Issue an agent can run',
        output: 'One backlog Issue, #1000. No tranche, no milestone'
      },
      surface: 'claude',
      lines: backlogChat,
      output: {
        kind: 'issue',
        issue: 1000,
        title: 'Resume refuses kept work',
        surface: 'apps/cli/src/commands/resume.ts · 1 objective · test plan'
      },
      sceneAfter: { tasks: 1, done: 0 }
    },
    {
      ...execStep(backlog, 0, 1),
      brief: {
        n: 2,
        title: 'Executing',
        command: 'vinaya task run --issue 1000',
        does: 'An agent fixes it in a sandbox, two fresh reviewers check it, every gate runs, the Issue closes on the merge',
        output: 'One reviewed pull request, merged to main, #1000 closed'
      }
    },
    archiveStep(
      'your backlog Issue',
      [closeTask(backlog.tasks[0] as Task)],
      'One Issue, one merge, one close. No tranche, no Milestone.',
      'Nobody ran this. The Archivist closed the Issue on its merge, automatically. What shipped and why stays in the record.'
    ),
    {
      ...improveStep(['21 min', '1 of 1', '3']),
      lines: improverIssueChat,
      brief: {
        title: 'Self-improvement',
        subtitle: 'The Log teaches the process',
        command: 'Automatic',
        does: 'The Log turns the run into a report. The Improver reads it and proposes what to change',
        output: 'A new Issue in the backlog, with its reason'
      }
    }
  ]
})
