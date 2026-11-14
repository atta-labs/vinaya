// Lists `target/` through the form named by its one argument and prints what it saw. The read recorder's tests run it
// with and without the listing probe preloaded: the probe must log the listing and the output must not change.
import fsDefault, * as fsNamespace from 'node:fs'
import { opendirSync, promises, readdirSync } from 'node:fs'
import { readdir as readdirPromise } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, 'target')
const sorted = (names: Iterable<unknown>) => [...names].map(String).sort()

const forms: Record<string, () => Promise<string[]> | string[]> = {
  named: () => sorted(readdirSync(target)),
  namespace: () => sorted(fsNamespace.readdirSync(target)),
  default: () => sorted(fsDefault.readdirSync(target)),
  require: () => sorted((require('node:fs') as typeof fsDefault).readdirSync(target)),
  createRequire: () => sorted((createRequire(import.meta.url)('node:fs') as typeof fsDefault).readdirSync(target)),
  computed: async () => {
    const fs = (await import(['node', 'fs'].join(':'))) as typeof fsDefault
    return sorted(fs.readdirSync(target))
  },
  package: () => (require('./package-lister.cjs') as (folder: string) => string[])(target),
  promisesMember: async () => sorted(await promises.readdir(target)),
  promisesImport: async () => sorted(await readdirPromise(target)),
  opendir: () => {
    const dir = opendirSync(target)
    const names: string[] = []
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) names.push(entry.name)
    dir.closeSync()
    return sorted(names)
  },
  glob: () => sorted(fsDefault.globSync('target/*.ts', { cwd: here })),
  recursive: () => sorted(readdirSync(target, { recursive: true })),
  url: () => sorted(readdirSync(new URL('./target/', import.meta.url))),
  chdir: () => {
    process.chdir(here)
    return sorted(readdirSync('target'))
  }
}

const form = process.argv[2] ?? ''
const run = forms[form]
if (!run) throw new Error(`unknown form ${form}`)
console.log(JSON.stringify({ form, names: await run() }))
