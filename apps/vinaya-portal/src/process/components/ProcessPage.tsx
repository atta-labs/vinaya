'use client'

import { useRouter } from 'next/navigation'
import { type ReactNode, useState } from 'react'
import { PortalBar } from '@/app/(site)/_components/PortalBar'
import { flowHref } from '../flows/routes'
import { ProcessProvider, storeEnvironment, useProcess } from '../store'
import { SetupWizard } from './SetupWizard'

function Inner({ logoUrl, search }: { logoUrl: string | null; search?: ReactNode }) {
  const router = useRouter()
  const { state, dispatch } = useProcess()
  /** True once the reader clicked a flow; until then no card is pressed and Start waits. */
  const [flowSet, setFlowSet] = useState(false)
  const setEnv = (env: typeof state.env) => {
    storeEnvironment(env)
    dispatch({ type: 'env', env, chosen: true })
  }

  return (
    <>
      <header className='sticky top-0 z-20 bg-background/90 backdrop-blur'>
        {/* The site's own bar, so the app sits inside the portal like every other page. No app toolbar during
            setup: the complexity and environment are chosen on the page itself. */}
        <PortalBar logoUrl={logoUrl} search={search} />
      </header>

      {state.envKnown && (
        // The two setup steps: one slide whose content changes (SetupWizard), laid out at real size.
        <main>
          <SetupWizard
            env={state.env}
            onEnv={setEnv}
            onEnvDone={() => setEnv(state.env)}
            flow={flowSet ? state.flow : null}
            onPick={(f) => {
              setFlowSet(true)
              dispatch({ type: 'flow', flow: f })
            }}
            // Start opens the flow's own subpage; the environment is stored, so it comes along.
            onStart={() => {
              storeEnvironment(state.env)
              router.push(flowHref(state.flow))
            }}
          />
        </main>
      )}
    </>
  )
}

/**
 * `/vinaya-process/demo`: the setup wizard. Each flow's walk is its own subpage (`../flows/<flow>/`).
 * `logoUrl` is the Vinaya mark from the CMS branding; the top bar shows it with a two-line tagline.
 */
export function ProcessPage({ logoUrl = null, search }: { logoUrl?: string | null; search?: ReactNode }) {
  return (
    <ProcessProvider flow='feature'>
      <Inner logoUrl={logoUrl} search={search} />
    </ProcessProvider>
  )
}
