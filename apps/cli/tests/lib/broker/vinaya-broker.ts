import type { ControlStoreDeps } from '@attalabs/aeg-core'
import type { DispatchTeeRecoveryDeps } from '../../../../../harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch'
import { vinayaBrokerPolicies } from '../../../../../harness/processes/vinaya-strict/integration/policies/vinaya-policies'
import {
  type BrokerEffectRequest,
  type BrokerLogEvent,
  createBroker,
  type InvocationContext
} from '../../../src/lib/broker'

/**
 * The broker the tests drive, built the way every production builder builds
 * it: from Vinaya's composed policies. `launchRecordDeps` stands in a
 * fixture's launch records for the verifier's runtime-directory walk; absent,
 * the verifier reads this machine's real launch records.
 */
export function authenticateWorkerInvocation(
  env: Readonly<Record<string, string | undefined>>,
  launchRecordDeps?: DispatchTeeRecoveryDeps,
  logEvent?: BrokerLogEvent
): InvocationContext {
  return createBroker(vinayaBrokerPolicies({ launchRecordDeps })).authenticateWorkerInvocation(env, logEvent)
}

export function requestEffect(
  deps: ControlStoreDeps,
  context: InvocationContext,
  request: BrokerEffectRequest,
  logEvent?: BrokerLogEvent
): string {
  return createBroker(vinayaBrokerPolicies()).requestEffect(deps, context, request, logEvent)
}
