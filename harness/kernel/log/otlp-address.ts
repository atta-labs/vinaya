import { type KernelConfig, resolveLogsHeaderValues } from '../config/schema/config-schema.js'
import { logsCredentialMissing } from './log-sink.js'

type AddressDecision =
  | { kind: 'address'; url: string; headers?: Record<string, string> }
  | { kind: 'none'; reason: string }

export function resolveOtlpAddress(input: {
  localConfig: Pick<KernelConfig, 'logs'> | null
  trustAnchorConfig: Pick<KernelConfig, 'logs'> | null
  unattended: boolean
  env: NodeJS.ProcessEnv
}): AddressDecision {
  const ci = Boolean(input.env.GITHUB_ACTIONS || input.env.CI)
  const anchored = input.unattended || ci
  const config = anchored ? input.trustAnchorConfig : input.localConfig
  if (input.localConfig?.logs === false || config?.logs === false) {
    return { kind: 'none', reason: 'logging is disabled' }
  }
  if (anchored && !config) return { kind: 'none', reason: 'default branch settings unavailable' }
  const address = config?.logs?.otlp
  if (!address) {
    return { kind: 'none', reason: anchored ? 'default branch has no logs.otlp address' : 'no logs.otlp address' }
  }
  if (ci && logsCredentialMissing(address.headers, input.env)) {
    return { kind: 'none', reason: 'CI is missing an OpenTelemetry header credential' }
  }
  return { kind: 'address', url: address.url, headers: resolveLogsHeaderValues(address.headers, input.env) }
}
