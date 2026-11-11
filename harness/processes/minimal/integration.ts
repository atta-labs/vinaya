import type { z } from 'zod'
import type {
  AnyProcessConfigSection,
  CheckRegistry,
  ProcessIntegration,
  ProcessLogSinkFactory
} from '../../kernel/dev-process-socket/contract/process-integration'

// The minimal process's integration: it fills the three kernel slots an install call fills with the smallest
// values that satisfy them, and declines the policies it has no use for. It imports nothing from any other process.

const noChecks: CheckRegistry = []

const section: AnyProcessConfigSection = {
  keys: [],
  fragment: {} as z.ZodRawShape,
  refinements: [],
  globalOnlyKeys: [],
  resolvers: undefined
}

function declined(policy: string): never {
  throw new Error(`the minimal process supplies no ${policy} policy: it launches no tool host`)
}

const integration: ProcessIntegration = {
  checks: () => noChecks,
  policies: {
    broker: () => declined('broker'),
    workerBoundary: () => declined('worker-boundary'),
    taskToolRouter: () => declined('task-tool router'),
    toolGrants: () => declined('tool-grant')
  },
  config: {
    provider: () => ({
      homeDir: '/minimal-process-home',
      loadConfig: () => null,
      loadTrustAnchorConfig: () => null,
      loadTrustAnchorConfigAsync: async () => null
    }),
    section: () => section
  },
  log: {
    loadSinkFactory: (() => {
      const factory: ProcessLogSinkFactory = () => ({
        log: () => {},
        logSync: () => {},
        runId: 'minimal-process',
        warmup: () => {},
        drain: async () => {},
        resetContext: () => {}
      })
      return factory
    }) as ProcessIntegration['log']['loadSinkFactory']
  }
}

export default integration
