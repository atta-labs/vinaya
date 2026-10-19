import type { FlowKey } from '../types'

/** Each flow's subpage of the demo: `/vinaya-process/demo/<slug>`. The setup wizard stays on `/vinaya-process/demo`. */
const flowSlug: Record<FlowKey, string> = {
  feature: 'complex',
  medium: 'medium',
  backlog: 'simple',
  hot: 'hot'
}

const DEMO_PATH = '/vinaya-process/demo'

export const flowHref = (flow: FlowKey) => `${DEMO_PATH}/${flowSlug[flow]}`
