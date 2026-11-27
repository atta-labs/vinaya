/**
 * What the Worker reads of the Log SDK: the stored-event contract — the store's line classifier and identity, the
 * redaction and the schemas — and, for the OpenTelemetry routes, the record check on `vinaya.*` names and the run's
 * trace id. The harness reaches the SDK by its package name, `@attalabs/vinaya-log-sdk`; the Worker's bundle
 * (`wrangler.jsonc` `alias`) and its test pool (`vitest.config.ts`) resolve that name to this file, because the
 * package's full entry also holds the writer and the sender, which need Node modules the Worker runtime does not
 * provide. The four modules re-exported whole hold the names the package's entry exports; the record check and the
 * trace id are named one by one, so nothing else of their modules is reached.
 */
export * from '../../../packages/log-sdk/src/contract/custom.js'
export * from '../../../packages/log-sdk/src/contract/redact.js'
export * from '../../../packages/log-sdk/src/contract/schema.js'
export * from '../../../packages/log-sdk/src/contract/store.js'
export {
  checkReservedNames,
  describeContractFailure,
  type ReservedName,
  reservedNamesOf
} from '../../../packages/log-sdk/src/contract/check.js'
export { traceIdFor } from '../../../packages/log-sdk/src/contract/ids.js'
