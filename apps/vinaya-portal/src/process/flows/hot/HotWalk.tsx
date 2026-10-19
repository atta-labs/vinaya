'use client'

import { type ReactNode, useMemo } from 'react'
import { brandPath } from '../../components/BrandIcon'
import { DemoWalk } from '../../components/DemoWalk'
import { stepLines } from '../../replay'
import { ProcessProvider, useProcess } from '../../store'
import { HotScene } from './HotScene'
import { hotProgress } from './progress'
import { hotStory } from './story'

/**
 * Hot issue's right column: its 3D descent, moved by the walk's own scroll. The aside keeps its padding for the
 * other flows' notes, so the scene steps out over it (the same insets, negated) and runs edge to edge like Medium
 * work's, while the step column keeps its own padding.
 */
function HotAside() {
  const { state, currentStep } = useProcess()
  // The scene keeps time with the step's own lines: the pairing, the gates, then the closing lines.
  const sceneAt = hotProgress(
    currentStep,
    state.cursor.progress,
    stepLines(currentStep, state.flow, state.agent).length
  )
  /** What the scene draws, in the reader's tracker, with the reader's agent as the Principal's pair. */
  const story = useMemo(
    () => hotStory(state.env.tracker, brandPath(state.env.tracker), state.env.agent),
    [state.env.tracker, state.env.agent]
  )
  return (
    <HotScene
      key={`${state.env.tracker}-${state.env.agent}`}
      {...sceneAt}
      story={story}
      className='-mx-6 -my-8 min-h-0 flex-1 md:-mr-10'
    />
  )
}

/** `/vinaya-process/demo/hot`: Hot issue, walked step by step beside its 3D descent. */
export function HotWalk({ logoUrl, search }: { logoUrl: string | null; search?: ReactNode }) {
  return (
    <ProcessProvider flow='hot' started>
      <DemoWalk logoUrl={logoUrl} search={search} aside={<HotAside />} />
    </ProcessProvider>
  )
}
