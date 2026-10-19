import { complexFlow } from '../flows/complex/flow'
import { hotFlow } from '../flows/hot/flow'
import { hotChat } from '../flows/hot/scripts'
import { mediumFlow } from '../flows/medium/flow'
import { simpleFlow } from '../flows/simple/flow'
import type { ChatLine, Flow, FlowKey, Step } from '../types'

/**
 * The four flows, each defined in its own folder (`../flows/<flow>/`). This
 * file only assembles them; the order is the order the setup cards show.
 */
export const flows: Record<FlowKey, Flow> = {
  feature: complexFlow,
  medium: mediumFlow,
  backlog: simpleFlow,
  hot: hotFlow
}

export const flowList = Object.values(flows)

/** Lines of a `chat` step, re-derived for the chosen agent where the script depends on it. */
export function linesFor(step: Step, flow: FlowKey, agent: 'claude' | 'codex'): ChatLine[] {
  const lines = flow === 'hot' && step.stage === 'architect' ? hotChat(agent) : (step.lines ?? [])
  const name = agent === 'codex' ? 'Codex' : 'Claude Code'
  return lines.map((l) => {
    if (l.kind === 'cmd' && (l.text === 'claude' || l.text === 'codex')) return { ...l, text: agent }
    if (l.kind === 'out' && /^(Claude Code|Codex) · /.test(l.text))
      return { ...l, text: l.text.replace(/^(Claude Code|Codex)/, name) }
    return l
  })
}
