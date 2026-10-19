'use client'

import { createContext, type ReactNode, use } from 'react'
import type { Environment } from './types'

/**
 * The reader's environment for any component that renders a choice in it
 * (the Log names their log server, the upstream copy their tracker). Null
 * outside the process page: components then show the generic version.
 */
const EnvironmentContext = createContext<Environment | null>(null)

export function EnvironmentProvider({ env, children }: { env: Environment; children: ReactNode }) {
  return <EnvironmentContext value={env}>{children}</EnvironmentContext>
}

export function useEnvironment(): Environment | null {
  return use(EnvironmentContext)
}
