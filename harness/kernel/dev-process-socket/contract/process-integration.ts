import type { z } from 'zod'
import type { installConfigProvider } from '../../config/loader/config-provider.js'
import type { ProcessConfigSection } from '../../config/schema/process-config-section.js'
import type { installCheckRegistry } from '../../gates/checks/registry.js'
import type { createWorkerBoundary } from '../../isolation/worker-boundary.js'
import type { registerDeferredLogSinkFactory } from '../../log/deferred-sink-factory.js'
import type { installDefaultLogSinkFactory } from '../../log/log-sink.js'
import type { createBroker } from '../../tools/host/broker.js'
import type { startDevToolsHost } from '../../tools/host/dev-tools-host.js'
import type { createTaskToolRouter } from '../../tools/host/router.js'

/**
 * What one process supplies to the kernel slots, as the module its
 * `process.yaml` names at `provides.integration` exports it. Each member is
 * typed by the slot it fills, so a process integration that type-checks fits
 * the kernel exactly:
 *
 * - `checks` — the check registry `installCheckRegistry` receives;
 * - `policies` — what `createBroker`, `createWorkerBoundary`,
 *   `createTaskToolRouter` and the dev-tools host's `toolGrants` receive;
 * - `config` — the provider `installConfigProvider` receives, and the
 *   configuration section the process's composition joins with the kernel's;
 * - `log` — the Log sink factory `installDefaultLogSinkFactory` receives, and
 *   the loader `registerDeferredLogSinkFactory` receives to defer it.
 *
 * Every member is a function or a module-free value, so building the
 * integration builds nothing: a composition root calls only what it installs.
 * The kernel never imports a process module; it names this interface only.
 */
export interface ProcessIntegration {
  readonly checks: () => CheckRegistry
  readonly policies: ProcessPolicies
  readonly config: ProcessConfig
  readonly log: ProcessLog
}

/** The check registry `installCheckRegistry` installs. */
export type CheckRegistry = Parameters<typeof installCheckRegistry>[0]

export interface ProcessPolicies {
  /** The broker's policies (`createBroker`). */
  readonly broker: () => Parameters<typeof createBroker>[0]
  /** The per-turn worker boundary's policies (`createWorkerBoundary`). */
  readonly workerBoundary: () => Parameters<typeof createWorkerBoundary>[0]
  /** The task-tool router's policies (`createTaskToolRouter`). */
  readonly taskToolRouter: () => Parameters<typeof createTaskToolRouter>[0]
  /** The tool-grant policy the dev-tools host serves (`startDevToolsHost`'s `toolGrants`). */
  readonly toolGrants: () => Parameters<typeof startDevToolsHost>[0]['toolGrants']
}

/**
 * Any process's configuration section. The section's own fragment, config
 * type and resolvers are the process's; the kernel names only the shape. The
 * config type is `never` because a section's refinements and global-only keys
 * read the process's own config type, which every such reader accepts.
 */
export type AnyProcessConfigSection = ProcessConfigSection<z.ZodRawShape, never, unknown>

export interface ProcessConfig {
  /** The configuration provider (`installConfigProvider`). */
  readonly provider: () => Parameters<typeof installConfigProvider>[0]
  /** The process's configuration section. */
  readonly section: () => AnyProcessConfigSection
}

/** The Log sink factory `installDefaultLogSinkFactory` installs. */
export type ProcessLogSinkFactory = Parameters<typeof installDefaultLogSinkFactory>[0]

export interface ProcessLog {
  /**
   * Loads the Log sink factory. `registerDeferredLogSinkFactory` takes it as
   * is, so the sink loads the first time something logs; an eager root passes
   * its result to `installDefaultLogSinkFactory`.
   */
  readonly loadSinkFactory: Parameters<typeof registerDeferredLogSinkFactory>[0] & (() => ProcessLogSinkFactory)
}
