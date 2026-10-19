import { note as complexNote } from '../flows/complex/notes'
import { note as hotNote } from '../flows/hot/notes'
import { note as mediumNote } from '../flows/medium/notes'
import { note as simpleNote } from '../flows/simple/notes'
import type { Environment, FlowKey, Step } from '../types'
import { fillEnv } from '../types'

/** Each flow's own words, kept in its folder (`../flows/<flow>/notes.ts`). */
const notes: Record<FlowKey, (step: Step) => string> = {
  feature: complexNote,
  medium: mediumNote,
  backlog: simpleNote,
  hot: hotNote
}

/**
 * What the animation beside each step will show, in words. The page renders
 * this text where the animation will go, revealed letter by letter on scroll,
 * until the animation itself is built. One sentence or two per stage.
 */
export function noteFor(step: Step, flow: FlowKey, env: Environment | null = null): string {
  return fillEnv(notes[flow](step), env)
}
