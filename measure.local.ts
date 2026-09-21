import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { selectAffectedTestFiles } from './apps/cli/src/lib/test-selector.js'
const root = process.cwd()
const alwaysRun = JSON.parse(readFileSync(root + '/vinaya.config.json', 'utf8')).prePush?.alwaysRun ?? []
const [file, ...names] = process.argv.slice(2)
const abs = join(root, file!)
const t0 = performance.now()
const r = selectAffectedTestFiles(root, [abs], {
  alwaysRun,
  affectedNames: names.length ? new Map([[abs, new Set(names)]]) : undefined
})
console.log(
  `${file} [${names.join(',') || 'FILE-LEVEL'}] => ${r.selected.length} of ${r.totalTestFiles} in ${(performance.now() - t0).toFixed(0)} ms`
)
