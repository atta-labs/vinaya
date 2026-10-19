'use client'

import { type ReactNode, useMemo } from 'react'
import { brandPath } from '../../components/BrandIcon'
import { DemoWalk } from '../../components/DemoWalk'
import { LifecycleScene } from '../../lifecycle/LifecycleScene'
import { lifecycleProgress } from '../../lifecycle/progress'
import { lifecycleStory } from '../../lifecycle/story'
import { stepLines } from '../../replay'
import { ProcessProvider, useProcess } from '../../store'

/** Complex work's right column: the portal's life-cycle animation, moved by the walk's own scroll. */
function ComplexAside() {
  const { state, currentStep } = useProcess()
  // The life-cycle scene keeps time with the step's own lines: the execution, then the archive's closing lines.
  const sceneAt = lifecycleProgress(
    currentStep.stage,
    state.cursor.progress,
    stepLines(currentStep, state.flow, state.agent).length,
    currentStep.closingLines?.length ?? 0,
    currentStep.outro
  )
  /** What the animation draws, in the reader's tracker. */
  const story = useMemo(() => lifecycleStory(state.env.tracker, brandPath(state.env.tracker)), [state.env.tracker])
  return <LifecycleScene key={state.env.tracker} {...sceneAt} story={story} className='min-h-0 flex-1' />
}

/** `/vinaya-process/demo/complex`: Complex work, walked step by step beside its 3D life cycle. */
export function ComplexWalk({ logoUrl, search }: { logoUrl: string | null; search?: ReactNode }) {
  return (
    <ProcessProvider flow='feature' started>
      <DemoWalk logoUrl={logoUrl} search={search} aside={<ComplexAside />} edgeToEdge />
    </ProcessProvider>
  )
}
