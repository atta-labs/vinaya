import { readFileSync } from 'node:fs'
import { selectAffectedTestFiles } from './apps/cli/src/lib/test-selector.js'
const root = process.cwd()
const alwaysRun = JSON.parse(readFileSync(root + '/vinaya.config.json', 'utf8')).prePush?.alwaysRun ?? []
for (const changed of process.argv.slice(2)) {
  const t0 = performance.now()
  const r = selectAffectedTestFiles(root, [changed], { alwaysRun })
  console.log(
    `${changed}: selected ${r.selected.length} of ${r.totalTestFiles} in ${(performance.now() - t0).toFixed(0)} ms (resolver=${r.resolver}, program=${r.programMs.toFixed(0)} ms)`
  )
}
