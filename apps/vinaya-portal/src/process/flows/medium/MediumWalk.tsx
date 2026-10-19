'use client'

import { type ReactNode, useMemo } from 'react'
import { brandPath } from '../../components/BrandIcon'
import { DemoWalk } from '../../components/DemoWalk'
import { stepLines } from '../../replay'
import { ProcessProvider, useProcess } from '../../store'
import { MediumScene } from './MediumScene'
import { mediumProgress } from './progress'
import { mediumStory } from './story'

/**
 * Medium work's right column: its 3D descent, moved by the walk's own scroll. The aside keeps its padding for the
 * other flows' notes, so the scene steps out over it (the same insets, negated) and runs edge to edge like Complex
 * work's, while the step column keeps its own padding.
 */
function MediumAside() {
  const { state, currentStep } = useProcess()
  // The scene keeps time with the step's own lines: the Operator's, then the closing lines.
  const sceneAt = mediumProgress(
    currentStep.stage,
    state.cursor.progress,
    stepLines(currentStep, state.flow, state.agent).length,
    currentStep.closingLines?.length ?? 0,
    currentStep.outro
  )
  /** What the scene draws, in the reader's tracker. */
  const story = useMemo(() => mediumStory(state.env.tracker, brandPath(state.env.tracker)), [state.env.tracker])
  return (
    <MediumScene key={state.env.tracker} {...sceneAt} story={story} className='-mx-6 -my-8 min-h-0 flex-1 md:-mr-10' />
  )
}

/** `/vinaya-process/demo/medium`: Medium work, walked step by step beside its 3D descent. */
export function MediumWalk({ logoUrl, search }: { logoUrl: string | null; search?: ReactNode }) {
  return (
    <ProcessProvider flow='medium' started>
      <DemoWalk logoUrl={logoUrl} search={search} aside={<MediumAside />} />
    </ProcessProvider>
  )
}
