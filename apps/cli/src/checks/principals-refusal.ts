import { PRINCIPALS_NOT_CONFIGURED_FIX, PrincipalsUnresolvedError } from '../lib/config'
import { CHECK_SCHEMA_VERSION, type CheckError, type CheckSeverity, emitCheckError } from './contract'

/**
 * The one `CheckError` line a check writes when `resolveTrustedPrincipals`
 * refuses — never plain stderr text or an uncaught throw, which the runner
 * marks as malformed output and which would lose the named fix.
 *
 * `severity` is the caller's: `not-configured` is always `error`; a
 * `read-failed` is `error` for a trust decision and `warning` for a push-time
 * check, which then treats the result that needed the list as unknown.
 */
export function principalsCheckError(
  check: string,
  err: PrincipalsUnresolvedError,
  severity: CheckSeverity
): CheckError {
  return {
    schema: CHECK_SCHEMA_VERSION,
    check,
    severity,
    message:
      err.kind === 'read-failed' && severity === 'warning'
        ? `the Principal read failed, so the result that needs the Principal list is unknown — ${err.message}`
        : err.message,
    agent_recovery_prompt:
      err.kind === 'not-configured'
        ? `Fix: ${PRINCIPALS_NOT_CONFIGURED_FIX}, then re-run \`vinaya check ${check}\`.`
        : `Confirm \`gh auth status\` passes and the forge is reachable, then re-run \`vinaya check ${check}\`.`
  }
}

/**
 * Emits `principalsCheckError` for `err` when it is a Principal refusal and
 * returns its kind; re-throws anything else. `readFailedSeverity` is the
 * severity a `read-failed` refusal carries in this check.
 */
export function emitPrincipalsRefusal(
  check: string,
  err: unknown,
  readFailedSeverity: CheckSeverity
): PrincipalsUnresolvedError['kind'] {
  if (!(err instanceof PrincipalsUnresolvedError)) throw err
  emitCheckError(principalsCheckError(check, err, err.kind === 'not-configured' ? 'error' : readFailedSeverity))
  return err.kind
}
