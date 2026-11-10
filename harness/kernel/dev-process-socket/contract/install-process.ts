import { installConfigProvider } from '../../config/loader/config-provider.js'
import { installCheckRegistry } from '../../gates/checks/registry.js'
import { registerDeferredLogSinkFactory } from '../../log/deferred-sink-factory.js'
import type { ProcessIntegration } from './process-integration.js'

/** A kernel slot a process fills: its Log sink factory, its configuration provider, its check registry. */
export type ProcessSlot = 'log' | 'config' | 'checks'

/** The order the slots install in, whichever the caller names: the Log factory, configuration, then checks. */
const SLOT_ORDER: readonly ProcessSlot[] = ['log', 'config', 'checks']

/** The part of the integration each slot reads. */
function partOf(integration: ProcessIntegration, slot: ProcessSlot): unknown {
  switch (slot) {
    case 'log':
      return integration.log?.loadSinkFactory
    case 'config':
      return integration.config?.provider
    case 'checks':
      return integration.checks
  }
}

/**
 * Fills the kernel slots `slots` names from a process's integration, in a fixed order, and does nothing else.
 * The Log slot is registered deferred (`registerDeferredLogSinkFactory`), so the sink and the process's Log
 * folder load the first time something logs, never here. Because the Log slot only registers, filling it first
 * or last is not observable, so an entry point that once installed it after configuration (the Engine runner,
 * the test preload) behaves the same under this fixed order. An integration lacking a part a named slot reads is
 * refused before any slot is filled.
 */
export function installProcess(integration: ProcessIntegration, slots: readonly ProcessSlot[]): void {
  const wanted = SLOT_ORDER.filter((slot) => slots.includes(slot))
  for (const slot of wanted) {
    if (typeof partOf(integration, slot) !== 'function') {
      throw new Error(`process integration lacks the part the '${slot}' slot needs`)
    }
  }
  for (const slot of wanted) {
    if (slot === 'log') registerDeferredLogSinkFactory(integration.log.loadSinkFactory)
    else if (slot === 'config') installConfigProvider(integration.config.provider())
    else installCheckRegistry(integration.checks())
  }
}
