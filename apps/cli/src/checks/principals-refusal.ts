import { PRINCIPALS_FIX, PrincipalsUnresolvedError } from '../lib/config'
import { CHECK_SCHEMA_VERSION, type CheckError, type CheckSeverity, emitCheckError } from './contract'

/**
 * How a check turns `resolveTrustedPrincipals`'s refusal into its one
 * `CheckError` line. The refusal must never reach the runner as plain text or
 * an uncaught exception: the runner marks either as malformed output and the
 * named fix is lost.
 *
 * Which kind refuses where: `not-configured` refuses in every check. A
 * `read-failed` refuses in a trust decision (`refuseUnresolvedPrincipals`);
 * a push-time check writes one warning instead, treats whatever needed the
 * list as unknown, and leaves its exit to the rest of the check
 * (`warnOnUnreadPrincipals`).
 */
export function principalsUnresolvedCheckError(
  check: string,
  err: PrincipalsUnresolvedError,
  severity: CheckSeverity
): CheckError {
  const recovery =
    err.kind === 'not-configured'
      ? `This repository names no Principal, so nobody's verdict, waiver or Issue close can be trusted. Ask a Principal to ${PRINCIPALS_FIX} (a list of GitHub logins), then re-run \`vinaya check ${check}\`.`
      : severity === 'error'
        ? `The Principal list could not be read from the forge, so this trust decision cannot be made. Confirm \`gh auth status\` passes (in CI, that the job's token is not empty) and the forge is reachable, then re-run \`vinaya check ${check}\`.`
        : `The Principal list could not be read from the forge, so the part of this check that needs it was not evaluated — the rest still ran. Confirm \`gh auth status\` passes and the forge is reachable, then re-run \`vinaya check ${check}\`.`
  return {
    schema: CHECK_SCHEMA_VERSION,
    check,
    severity,
    message: `${check}: ${err.message}`,
    agent_recovery_prompt: recovery
  }
}

/** A trust decision: either kind writes one `error` line and exits 1. Anything else `err` holds is re-thrown untouched. */
export function refuseUnresolvedPrincipals(check: string, err: unknown): never {
  if (!(err instanceof PrincipalsUnresolvedError)) throw err
  emitCheckError(principalsUnresolvedCheckError(check, err, 'error'))
  process.exit(1)
}

/**
 * A push-time check: `not-configured` refuses as a trust decision does; a
 * `read-failed` writes one `warning` line and returns, so the caller treats
 * the result that needed the list as unknown.
 */
export function warnOnUnreadPrincipals(check: string, err: unknown): void {
  if (err instanceof PrincipalsUnresolvedError && err.kind === 'read-failed') {
    emitCheckError(principalsUnresolvedCheckError(check, err, 'warning'))
    return
  }
  refuseUnresolvedPrincipals(check, err)
}
