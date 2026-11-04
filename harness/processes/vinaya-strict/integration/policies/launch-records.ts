/**
 * Vinaya's launch-record verifier: the role dispatch's own launch records
 * (`launchRecordMatchesRun`), read through the tee-recovery walk of this
 * machine's runtime directory (`realDispatchTeeRecoveryDeps`) unless the
 * caller hands it another reader.
 */

import type { LaunchRecordVerifier } from '../../../../kernel/tools/host/broker.js'
import type { Role } from '../../../../kernel/log/schema'
import {
  type DispatchTeeRecoveryDeps,
  launchRecordMatchesRun,
  realDispatchTeeRecoveryDeps
} from '../../loops/dev-review/dispatch/dispatch.js'

export function vinayaLaunchRecordVerifier(
  deps: DispatchTeeRecoveryDeps = realDispatchTeeRecoveryDeps()
): LaunchRecordVerifier {
  return { matchesRun: (runId, role, task) => launchRecordMatchesRun(deps, runId, role as Role, task) }
}
