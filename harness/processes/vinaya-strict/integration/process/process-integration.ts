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
 * Every member is a function, so importing this module builds no registry
 * and no policy. The Log sink factory alone loads its module when called, the
 * same deferred load the command line's startup uses, so the Log sink loads
 * the first time something logs.
 */

import type { ProcessIntegration } from '../../../../kernel/dev-process-socket/contract/process-integration.js'
import { coreCheckRegistry } from '../../checks/registry.js'
import { vinayaConfigProvider } from '../config/compose.js'
import { VINAYA_CONFIG_SECTION } from '../config/vinaya-config-section.js'
import {
  vinayaBrokerPolicies,
  vinayaRouterPolicies,
  vinayaToolGrantPolicy,
  vinayaWorkerBoundaryPolicies
} from '../policies/vinaya-policies.js'

type LogSinkFactoryModule = typeof import('../log/log-sink-factory.js')

const logSinkFactory = (): LogSinkFactoryModule => require('../log/log-sink-factory.js') as LogSinkFactoryModule

export const vinayaProcessIntegration: ProcessIntegration = {
  checks: () => coreCheckRegistry(),
  policies: {
    broker: () => vinayaBrokerPolicies(),
    workerBoundary: () => vinayaWorkerBoundaryPolicies(),
    taskToolRouter: () => vinayaRouterPolicies(),
    toolGrants: () => vinayaToolGrantPolicy()
  },
  config: {
    provider: () => vinayaConfigProvider,
    section: () => VINAYA_CONFIG_SECTION
  },
  log: {
    loadSinkFactory: () => logSinkFactory().createVinayaLogSink
  }
}
