import { expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { discoverWorkspacePackages, isTestFile, selectAffectedTestFiles, walkFiles } from '../../src/lib/test-selector'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'
const ROOT = join(import.meta.dir, '..', '..', '..', '..')
it('probe', () => {
  const tests = discoverWorkspacePackages(ROOT)
    .filter((p) => p.bunTestCompatible)
    .flatMap((d) => walkFiles(d.dir).filter(isTestFile))
  const outdir = mkdtempSync(join(tmpdir(), 'probe-oracle-'))
  spawnSyncBudgeted(
    'bun',
    ['build', '--target=node', '--sourcemap=external', `--root=${ROOT}`, `--outdir=${outdir}`, ...tests],
    { cwd: ROOT, encoding: 'utf8', env: { ...stripVinayaEnv(), HOME: process.env.HOME, PATH: process.env.PATH } },
    120000,
    'oracle'
  )
  const src = new Map<string, Set<string>>()
  for (const t of tests) {
    const mp = join(outdir, relative(ROOT, t).replace(/\.[cm]?[jt]sx?$/, '.js.map'))
    const set = new Set<string>()
    if (existsSync(mp))
      for (const s of JSON.parse(readFileSync(mp, 'utf8')).sources as string[])
        for (const c of [resolve(dirname(mp), s), resolve('/', s.replace(/^(?:\.\.\/)+/, ''))])
          if (c.startsWith(ROOT + '/')) set.add(c)
    src.set(t, set)
  }
  rmSync(outdir, { recursive: true, force: true })
  for (const f of [
    'packages/aeg-core/src/review-input-manifest.ts',
    'packages/aeg-core/src/anchored-region.ts',
    'packages/aeg-core/src/parse-registry.ts',
    'apps/cli/src/lib/dispatch.ts',
    'apps/cli/src/lib/config.ts',
    'apps/cli/src/commands/demo.ts',
    'apps/cli/src/lib/test-selector.ts'
  ]) {
    const changed = join(ROOT, f)
    const sel = new Set(selectAffectedTestFiles(ROOT, [changed]).selected)
    const reached = tests.filter((t) => src.get(t)!.has(changed))
    const missed = reached.filter((t) => !sel.has(t))
    console.log(`${f}: oracle=${reached.length} selector=${sel.size} missed=${missed.length}`)
    if (missed.length)
      console.log(
        '   e.g.',
        missed.slice(0, 3).map((t) => t.slice(ROOT.length + 1))
      )
  }
  expect(1).toBe(1)
}, 180000)
