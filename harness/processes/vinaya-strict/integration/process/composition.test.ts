import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadProcess } from '../../../../kernel/dev-process-socket/loader/load-process'

/**
 * Each entry point installs Vinaya through the kernel's one `installProcess` call on the module
 * `process.yaml` names at `provides.integration`. The bundled command line imports that module statically, so
 * nothing loads it from the declared path; this test is what ties the two: it reads each entry point's source,
 * resolves the integration module it imports, and holds it to the declared path and to the slots it names.
 */
const processDir = join(import.meta.dir, '..', '..')
const declared = loadProcess(processDir).provided?.integration
if (!declared) throw new Error('process.yaml declares no integration')

const ENTRY_POINTS: Record<string, string[]> = {
  'integration/cli-services.ts': ['log', 'config', 'checks'],
  'tools/program-entry.ts': ['log', 'config', 'checks'],
  'bin/run-engine.ts': ['log', 'config', 'checks'],
  'gates/ring2-audits/audit.ts': ['log', 'config', 'checks'],
  'integration/test-preload.ts': ['config', 'log'],
  'integration/push-progress-observer.ts': ['config'],
  'integration/pre-push-progress-dir.ts': ['config'],
  'evals/step-one.ts': ['log'],
  'evals/whole-loop.ts': ['log'],
  'evals/harbor-trial.ts': ['log'],
  'evals/harbor-tasks.ts': ['log'],
  'evals/harbor-grade.ts': ['log'],
  'evals/harbor-results.ts': ['log']
}

const DIRECT_INSTALLERS = /\b(installVinayaLogSinkFactory|installVinayaConfigProvider|installVinayaCheckRegistry)\b/

/** The integration module a source file names in an import, `import()` or `require`, resolved to a path. */
function integrationModulesOf(file: string, source: string): string[] {
  const specifiers = [...source.matchAll(/(?:from|import\(|require\()\s*'([^']*process-integration[^']*)'/g)].map(
    (match) => match[1] as string
  )
  return specifiers.map((specifier) => resolve(dirname(file), specifier.replace(/\.(js|ts)$/, '')))
}

describe('every entry point installs the module process.yaml declares as its integration', () => {
  for (const [relative, slots] of Object.entries(ENTRY_POINTS)) {
    test(`${relative} installs the declared integration for ${slots.join(', ')}`, () => {
      const file = join(processDir, relative)
      // Comments do not install anything: a commented-out call must not satisfy the test.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      const modules = integrationModulesOf(file, source)
      expect(modules.length).toBeGreaterThan(0)
      for (const module of modules) expect(module).toBe(declared.replace(/\.ts$/, ''))
      expect(source).not.toMatch(DIRECT_INSTALLERS)

      const calls = [...source.matchAll(/installProcess\(\s*vinayaProcessIntegration,\s*\[([^\]]*)\]\s*\)/g)]
      expect(calls.length).toBeGreaterThan(0)
      const named = calls.flatMap((call) => [...(call[1] as string).matchAll(/'(\w+)'/g)].map((slot) => slot[1]))
      expect([...named].sort()).toEqual([...slots].sort())
    })
  }

  test('the command line installs through cli-services, which index.ts calls', () => {
    const index = readFileSync(join(processDir, '..', '..', '..', 'apps/cli/src/index.ts'), 'utf8')
    expect(index).toMatch(/installServices\(\)/)
    expect(index).not.toMatch(DIRECT_INSTALLERS)
  })
})
