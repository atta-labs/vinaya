import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  hasConfigProvider,
  installConfigProvider,
  uninstallConfigProvider
} from '../../config/loader/config-provider.js'
import { installCheckRegistry, installedCheckRegistry } from '../../gates/checks/registry.js'
import { loadDeferredLogSinkFactory, registerDeferredLogSinkFactory } from '../../log/deferred-sink-factory.js'
import { installProcess } from './install-process.js'
import type { ProcessIntegration } from './process-integration.js'

function fakeIntegration(calls: string[]): ProcessIntegration {
  const provider = { homeDir: '/fake-home' } as unknown as ReturnType<ProcessIntegration['config']['provider']>
  const factory = (() => ({})) as unknown as ReturnType<ProcessIntegration['log']['loadSinkFactory']>
  return {
    checks: () => {
      calls.push('checks')
      return [] as unknown as ReturnType<ProcessIntegration['checks']>
    },
    policies: {} as ProcessIntegration['policies'],
    config: {
      provider: () => {
        calls.push('config')
        return provider
      },
      section: () => {
        throw new Error('the install call never reads the section')
      }
    },
    log: {
      loadSinkFactory: (() => {
        calls.push('log')
        return factory
      }) as ProcessIntegration['log']['loadSinkFactory']
    }
  }
}

// The slots are process-wide: put back what the test process had installed.
let previousConfig: ReturnType<typeof uninstallConfigProvider>
let previousChecks: ReturnType<typeof installedCheckRegistry> | undefined
let previousLog: ReturnType<typeof loadDeferredLogSinkFactory>
beforeEach(() => {
  previousConfig = uninstallConfigProvider()
  previousChecks = (() => {
    try {
      return installedCheckRegistry()
    } catch {
      return undefined
    }
  })()
  previousLog = loadDeferredLogSinkFactory()
})
afterEach(() => {
  uninstallConfigProvider()
  if (previousConfig) installConfigProvider(previousConfig)
  if (previousChecks) installCheckRegistry(previousChecks)
  if (previousLog) {
    const restored = previousLog
    registerDeferredLogSinkFactory(() => restored)
  }
})

it('fills the configuration and check slots, and registers the Log slot deferred, in that order of calls', () => {
  const calls: string[] = []
  installProcess(fakeIntegration(calls), ['checks', 'config', 'log'])
  expect(calls).toEqual(['config', 'checks'])
  expect(hasConfigProvider()).toBe(true)
  expect(installedCheckRegistry()).toEqual([])
  expect(loadDeferredLogSinkFactory()).toBeFunction()
  expect(calls).toEqual(['config', 'checks', 'log'])
})

it('fills only the slots it is told to', () => {
  const calls: string[] = []
  installProcess(fakeIntegration(calls), ['config'])
  expect(calls).toEqual(['config'])
  expect(hasConfigProvider()).toBe(true)
})

it('refuses an integration that lacks a part, before filling any slot', () => {
  const calls: string[] = []
  const noChecks = { ...fakeIntegration(calls), checks: undefined } as unknown as ProcessIntegration
  expect(() => installProcess(noChecks, ['config', 'checks'])).toThrow("'checks' slot")
  expect(calls).toEqual([])
  expect(hasConfigProvider()).toBe(false)
  const noLog = { ...fakeIntegration(calls), log: undefined } as unknown as ProcessIntegration
  expect(() => installProcess(noLog, ['log'])).toThrow("'log' slot")
})
