import type { Step } from '../../types'

/** Medium work: what the animation beside each step will show, in words (before {tracker} and {project} are filled). */
export function note(step: Step): string {
  switch (step.stage) {
    case 'architect':
      return 'The need arrives from {tracker}. The Architect reads the code and the specs, and a Milestone takes shape, its task intents sketched inside it.'
    case 'planner':
      return 'An intent splits into tasks. Each becomes an Issue with its brief, and arrows between them set the order they run in.'
    case 'loop':
      return 'Each task enters its own sandbox. A Developer writes, Reviewers read, round after round until the verdict is approve. Hooks fire on every commit; CI on every push.'
    case 'archive':
      return 'The last pull request merges. Issues close, the Milestone closes, branches are archived. Nobody pressed a button.'
    case 'improve':
      return 'Every record in the Log flows into the Observer. Figures rise out of it, and out of the figures, proposals for the next change to the process.'
    default:
      return 'One {project} in {tracker}: a feature that ships on its own, as many agents as it takes.'
  }
}
