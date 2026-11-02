import type { KernelConfig } from '../schema/config-schema.js'

/**
 * Where a process's composition registers the type of its composed
 * configuration, by augmenting this interface with `config: <that type>`. A
 * program that holds no composition reads `KernelConfig`; one that holds one
 * reads the composed type, so a kernel reader's results stay assignable
 * wherever the composed configuration is expected — without the kernel ever
 * importing the process.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by a process's composition
export interface ComposedConfigRegistry {}

/** The configuration type a provider returns: the registered composed type, else `KernelConfig`. */
export type ProvidedConfig = ComposedConfigRegistry extends { config: infer Config extends KernelConfig }
  ? Config
  : KernelConfig

/**
 * How kernel code reads configuration. The kernel never imports a process's
 * composed schema or its loader: a composition root — a command-line entry
 * point, a process's runner entry — installs one provider before any command
 * or run starts, and every kernel read goes through `configProvider()`. A read
 * with no provider installed is refused, naming the call that installs one.
 */
export interface ConfigProvider {
  /** The machine-wide home folder: the global file, the log outbox and the per-repository runtime folders sit under it. */
  readonly homeDir: string
  /** The working tree's configuration, or `null` when none is found or it is invalid. */
  loadConfig(): ProvidedConfig | null
  /** The default branch's configuration, or `null` on any failure. */
  loadTrustAnchorConfig(): ProvidedConfig | null
  /** `loadTrustAnchorConfig` without blocking the event loop. */
  loadTrustAnchorConfigAsync(
    fetcher?: () => Promise<string>,
    options?: { quiet?: boolean }
  ): Promise<ProvidedConfig | null>
}

let installed: ConfigProvider | null = null

export const NO_CONFIG_PROVIDER_MESSAGE =
  'no configuration provider is installed — a composition root must call installConfigProvider() before any configuration read'

/** Installs the provider every kernel read uses; a later install replaces it. */
export function installConfigProvider(provider: ConfigProvider): void {
  installed = provider
}

/** Whether a provider is installed. */
export function hasConfigProvider(): boolean {
  return installed !== null
}

/** The installed provider; throws when none is installed. */
export function configProvider(): ConfigProvider {
  if (!installed) throw new Error(NO_CONFIG_PROVIDER_MESSAGE)
  return installed
}

/** Removes the installed provider — for tests that prove the refusal. Returns the one it removed. */
export function uninstallConfigProvider(): ConfigProvider | null {
  const previous = installed
  installed = null
  return previous
}
