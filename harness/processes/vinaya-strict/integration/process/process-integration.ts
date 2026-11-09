/**
 * Vinaya's process integration: the one module `process.yaml` names at
 * `provides.integration`, implementing the kernel's `ProcessIntegration`
 * (`harness/kernel/dev-process-socket/contract/process-integration.ts`). It
 * gathers what Vinaya already supplies to each kernel slot — the check
 * registry (`checks/registry.ts`), the policies
 * (`integration/policies/vinaya-policies.ts`), the configuration provider and
 * section (`integration/config/compose.ts`, `vinaya-config-section.ts`) and
 * the Log sink factory (`integration/log/log-sink-factory.ts`) — and moves
 * none of them.
 *
 * Each member loads its module only when called, so importing this module
 * builds nothing: the configuration module installs its provider as it loads,
 * and the Log sink factory must stay deferred until something logs.
 */

import type { ProcessIntegration } from '../../../../kernel/dev-process-socket/contract/process-integration.js'

type ChecksModule = typeof import('../../checks/registry.js')
type PoliciesModule = typeof import('../policies/vinaya-policies.js')
type ComposeModule = typeof import('../config/compose.js')
type ConfigSectionModule = typeof import('../config/vinaya-config-section.js')
type LogSinkFactoryModule = typeof import('../log/log-sink-factory.js')

const checks = (): ChecksModule => require('../../checks/registry.js') as ChecksModule
const policies = (): PoliciesModule => require('../policies/vinaya-policies.js') as PoliciesModule
const compose = (): ComposeModule => require('../config/compose.js') as ComposeModule
const configSection = (): ConfigSectionModule => require('../config/vinaya-config-section.js') as ConfigSectionModule
const logSinkFactory = (): LogSinkFactoryModule => require('../log/log-sink-factory.js') as LogSinkFactoryModule

export const vinayaProcessIntegration: ProcessIntegration = {
  checks: () => checks().coreCheckRegistry(),
  policies: {
    broker: () => policies().vinayaBrokerPolicies(),
    workerBoundary: () => policies().vinayaWorkerBoundaryPolicies(),
    taskToolRouter: () => policies().vinayaRouterPolicies(),
    toolGrants: () => policies().vinayaToolGrantPolicy()
  },
  config: {
    provider: () => compose().vinayaConfigProvider,
    section: () => configSection().VINAYA_CONFIG_SECTION
  },
  log: {
    loadSinkFactory: () => logSinkFactory().createVinayaLogSink
  }
}
