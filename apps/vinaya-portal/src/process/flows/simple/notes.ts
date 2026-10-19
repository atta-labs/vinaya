import type { Step } from '../../types'

/** Simple task: what the animation beside each step will show, in words (before {tracker} and {project} are filled). */
export function note(step: Step): string {
  switch (step.stage) {
    case 'architect':
      return 'The need arrives from {tracker}. The Architect reads the code and the specs, and a Milestone takes shape, its task intents sketched inside it.'
    case 'planner':
      return 'One Issue is written: its Surface, its objectives, its test plan. A contract a loop can run alone.'
    case 'loop':
      return 'The Issue enters its own sandbox. A Developer writes, two fresh Reviewers read, until the verdict is approve. Hooks fire on every commit; CI on every push.'
    case 'archive':
      return 'The pull request merges. The Issue closes, its branch is archived. Nobody pressed a button.'
    case 'improve':
      return 'Every record in the Log flows into the Observer. Figures rise out of it, and out of the figures, proposals for the next change to the process.'
    default:
      return 'One Issue in the {tracker} backlog: a small task, found while working, run on its own.'
  }
}
