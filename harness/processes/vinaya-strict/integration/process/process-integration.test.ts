import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadProcess } from '../../../../kernel/dev-process-socket/loader/load-process'
import { vinayaProcessIntegration } from './process-integration'

const processDir = join(import.meta.dir, '..', '..')
const loaded = loadProcess(processDir)

const LAUNCHED_ROLES = ['developer', 'code-reviewer', 'security-reviewer']
const INTERACTIVE_ROLES = ['operator', 'planner', 'architect', 'archivist', 'tranche-archivist']

describe("Vinaya's process declaration", () => {
  test('declares every launched and interactive role, each with its doctrine', () => {
    const provided = loaded.provided
    expect(provided).toBeDefined()
    expect(Object.keys(provided?.roles ?? {}).sort()).toEqual([...LAUNCHED_ROLES, ...INTERACTIVE_ROLES].sort())
    for (const role of Object.values(provided?.roles ?? {})) expect(role.doctrine).toEndWith('doctrine.md')
  })

  test('declares grants and an output schema for each launched role, and none for an interactive one', () => {
    const roles = loaded.provided?.roles ?? {}
    for (const name of LAUNCHED_ROLES) {
      expect(roles[name]?.grants).toEndWith(join(name, 'grants.yaml'))
      expect(roles[name]?.outputSchema).toEndWith(join(name, 'output.schema.json'))
    }
    for (const name of INTERACTIVE_ROLES) {
      expect(roles[name]?.grants).toBeUndefined()
      expect(roles[name]?.outputSchema).toBeUndefined()
    }
    expect(roles.planner?.tools).toBe(join(processDir, 'thinking/planner/tools'))
  })

  test('names this module as its integration', () => {
    expect(loaded.provided?.integration).toBe(join(import.meta.dir, 'process-integration.ts'))
  })
})

describe("Vinaya's process integration supplies every part its declaration names, from the declared module", () => {
  const declared = loaded.provided
  if (!declared) throw new Error('process.yaml declares no provides')

  test('checks: the check registry the declared checks module builds', async () => {
    const module = (await import(declared.checks)) as typeof import('../../checks/registry')
    const registry = vinayaProcessIntegration.checks()
    expect(registry.length).toBeGreaterThan(0)
    expect(registry).toEqual(module.coreCheckRegistry())
  })

  test('policies: the broker, worker-boundary, router and grant policies the declared policies module builds', async () => {
    const module = (await import(declared.policies)) as typeof import('../policies/vinaya-policies')
    const { policies } = vinayaProcessIntegration
    const broker = policies.broker()
    const expected = module.vinayaBrokerPolicies()
    expect(broker.protectedPaths).toBe(expected.protectedPaths)
    expect(broker.roles).toBe(expected.roles)
    expect(typeof broker.launchRecords).toBe(typeof expected.launchRecords)
    expect(policies.workerBoundary()).toEqual(module.vinayaWorkerBoundaryPolicies())
    expect(policies.taskToolRouter()).toEqual(module.vinayaRouterPolicies())
    expect(policies.toolGrants()).toBe(module.vinayaToolGrantPolicy())
  })

  test('config_section: the section the declared configuration module exports, and the composed provider', async () => {
    const module = (await import(declared.configSection)) as typeof import('../config/vinaya-config-section')
    expect(vinayaProcessIntegration.config.section()).toBe(module.VINAYA_CONFIG_SECTION)
    const compose = await import('../config/compose')
    expect(vinayaProcessIntegration.config.provider()).toBe(compose.vinayaConfigProvider)
  })

  test('log: the Vinaya Log sink factory, loaded only when asked', async () => {
    const module = await import('../log/log-sink-factory')
    expect(vinayaProcessIntegration.log.loadSinkFactory()).toBe(module.createVinayaLogSink)
  })

  test('the declaration and the integration name the same module parts', () => {
    const declaredParts = Object.keys(loaded.identity.provides ?? {})
      .filter((part) => part !== 'roles' && part !== 'integration')
      .sort()
    const integrationParts: Record<string, keyof typeof vinayaProcessIntegration> = {
      checks: 'checks',
      policies: 'policies',
      config_section: 'config'
    }
    expect(declaredParts).toEqual(Object.keys(integrationParts).sort())
    for (const part of declaredParts) {
      expect(vinayaProcessIntegration[integrationParts[part] as keyof typeof vinayaProcessIntegration]).toBeDefined()
    }
  })
})
