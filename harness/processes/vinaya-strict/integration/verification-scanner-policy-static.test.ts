/**
 * The push gate reads the folder-scanning declarations from the source text of
 * `verification-scanner-policy.ts` without running it, so the list must stay a
 * plain literal. A function call or a spread there makes the static read return
 * nothing, and then every changed file those tests scan falls to the selection's
 * "run every test" fallback.
 */
import { expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readExportedScannerDeclarations } from '../../../../scripts/test-suites/inventory-check'
import { SCANNER_DECLARATIONS } from './verification-scanner-policy'

it('the statically read scanner declarations equal the ones the module exports', () => {
  const file = 'harness/processes/vinaya-strict/integration/verification-scanner-policy.ts'
  const text = readFileSync(join(import.meta.dir, 'verification-scanner-policy.ts'), 'utf8')
  const read = readExportedScannerDeclarations(text, file, 'SCANNER_DECLARATIONS')
  expect(read).not.toBeNull()
  expect(read).toEqual(SCANNER_DECLARATIONS.map((d) => ({ test: d.test, roots: [...d.roots], trigger: d.trigger })))
})

it("the command line's import guard names every other application's manifest among its roots", () => {
  const repoRoot = join(import.meta.dir, '../../../..')
  const entry = SCANNER_DECLARATIONS.find((d) => d.test === 'apps/cli/tests/import-boundary.test.ts')
  expect(entry?.trigger).toBe('content')
  expect(entry?.roots).toContain('apps/cli/')
  const manifests = readdirSync(join(repoRoot, 'apps'))
    .filter((app) => app !== 'cli' && existsSync(join(repoRoot, 'apps', app, 'package.json')))
    .map((app) => `apps/${app}/package.json`)
  expect(manifests.length).toBeGreaterThan(0)
  for (const manifest of manifests) expect(entry?.roots).toContain(manifest)
})
