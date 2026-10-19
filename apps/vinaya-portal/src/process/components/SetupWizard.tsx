'use client'

import { ArrowRight } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/ui/components'
import type { Environment, FlowKey } from '../types'
import { EnvironmentCards } from './Environment'
import { SetupSlide } from './SetupSlide'
import { FlowActions, FlowCards } from './StepSection'

type SetupStep = 'env' | 'flow'

const TITLE: Record<SetupStep, string> = {
  env: 'Set up your work environment',
  flow: 'What you have to deploy next'
}

/* Continue and Back. Only the title and the choices move; the header line and the footer stay put. The outgoing step
   fades and slides 16px away (160ms, ease-in), then the incoming one fades in from 24px on the other side (280ms,
   ease-out); Back mirrors it. Reduced motion swaps at once. */
const OUT = { duration: 160, easing: 'cubic-bezier(0.4, 0, 1, 1)' }
const IN = { duration: 280, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }

/**
 * The demo's setup: step 1, the environment; step 2, the flow. One slide whose content changes, so the step line,
 * its segments and the footer never move. Focus goes to the new step's title, and on a tablet or a phone the page
 * returns to the top first.
 */
export function SetupWizard({
  env,
  onEnv,
  onEnvDone,
  flow,
  onPick,
  onStart
}: {
  env: Environment
  onEnv: (e: Environment) => void
  /** Continue: the environment is confirmed. */
  onEnvDone: () => void
  /** The picked flow; null until the reader picks one. Start waits for it. */
  flow: FlowKey | null
  onPick: (f: FlowKey) => void
  onStart: () => void
}) {
  const [step, setStep] = useState<SetupStep>('env')
  const content = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const busy = useRef(false)

  const go = async (to: SetupStep) => {
    if (busy.current || to === step) return
    const el = content.current
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const sign = to === 'flow' ? 1 : -1
    busy.current = true
    if (el && !reduced) {
      await el.animate(
        [
          { opacity: 1, transform: 'translateX(0)' },
          { opacity: 0, transform: `translateX(${-16 * sign}px)` }
        ],
        { ...OUT, fill: 'forwards' }
      ).finished
    }
    if (window.innerWidth < 1280) window.scrollTo({ top: 0 })
    setStep(to)
    requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true })
      const node = content.current
      if (node && !reduced) {
        node.getAnimations().forEach((a) => {
          a.cancel()
        })
        node.animate(
          [
            { opacity: 0, transform: `translateX(${24 * sign}px)` },
            { opacity: 1, transform: 'translateX(0)' }
          ],
          IN
        )
      }
      busy.current = false
    })
  }

  return (
    <SetupSlide
      n={step === 'env' ? 1 : 2}
      title={TITLE[step]}
      contentRef={content}
      headingRef={heading}
      actions={
        step === 'env' ? (
          <Button
            onClick={() => {
              onEnvDone()
              void go('flow')
            }}
            hoverScale={1}
            tapScale={1}
            className='max-md:flex-1'
          >
            Continue
            <ArrowRight />
          </Button>
        ) : (
          <FlowActions flow={flow} onBack={() => void go('env')} onStart={onStart} />
        )
      }
    >
      {step === 'env' ? <EnvironmentCards value={env} onChange={onEnv} /> : <FlowCards flow={flow} onPick={onPick} />}
    </SetupSlide>
  )
}
