/**
 * The push gate reads the folder-scanning declarations from the source text of
 * `verification-scanner-policy.ts` without running it, so the list must stay a
 * plain literal. A function call or a spread there makes the static read return
 * nothing, and then every changed file those tests scan falls to the selection's
 * "run every test" fallback.
 */
import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
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
