import type { Step } from '../../types'

/** Hot issue: what the animation beside each step will show, in words (before {tracker} and {project} are filled). */
export function note(step: Step): string {
  switch (step.stage) {
    case 'architect':
      return 'A single Issue appears, marked hot. Its brief is three lines long. Nothing to plan: you start right away.'
    case 'planner':
      return 'An intent splits into tasks. Each becomes an Issue with its brief, and arrows between them set the order they run in.'
    case 'loop':
      return "You and your agent work together on the Issue's branch. Every commit passes through the Ring 0 hooks, every push through CI; each one lights as it runs and turns green."
    case 'archive':
      return 'The last pull request merges. Issues close, the Milestone closes, branches are archived. Nobody pressed a button.'
    case 'improve':
      return 'Every record in the Log flows into the Observer. Figures rise out of it, and out of the figures, proposals for the next change to the process.'
    default:
      return 'One {project} in {tracker}: a feature that ships on its own, as many agents as it takes.'
  }
}
