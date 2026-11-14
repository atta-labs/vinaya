// Calls one of Bun's resolve functions, or the `dlopen` of `bun:ffi`, through the import form the argument names. Each
// looks up or loads from folder listings the probe's wrap cannot see, so the probe logs the process wholly scanned.
import { resolveSync } from 'bun'
import { dlopen, suffix } from 'bun:ffi'
import * as ffi from 'bun:ffi'

const form = process.argv[2]
// No library is there to load: the call throws, the same way with the probe as without it.
const opens = (open: (path: string, symbols: Record<string, never>) => unknown): string => {
  try {
    open('/nonexistent/vinaya-listing-probe.so', {})
    return 'opened'
  } catch {
    return 'threw'
  }
}
const named = (path: string): string => path.slice(import.meta.dir.length)
let result: string
if (form === 'resolveSync') result = named(Bun.resolveSync('./target/mod', import.meta.dir))
else if (form === 'resolve') result = named(await Bun.resolve('./target/mod', import.meta.dir))
else if (form === 'namedResolveSync') result = named(resolveSync('./target/mod', import.meta.dir))
else if (form === 'dlopen') result = opens(dlopen)
else if (form === 'namespaceDlopen') result = opens(ffi.dlopen)
else if (form === 'dynamicDlopen') result = opens((await import('bun:ffi')).dlopen)
else if (form === 'requireDlopen') result = opens((require('bun:ffi') as typeof ffi).dlopen)
else if (form === 'cc' || form === 'linkSymbols' || form === 'CFunction') {
  // `cc` compiles C that lists `target/` itself; `linkSymbols` and `CFunction` then call the compiled function's pointer.
  const compiled = ffi.cc({
    source: `${import.meta.dir}/lists-folder.c`,
    flags: ['-nostdlib'],
    symbols: { count_entries: { args: ['cstring'], returns: 'int' } }
  })
  const folder = Buffer.from(`${import.meta.dir}/target\0`)
  const pointer = compiled.symbols.count_entries.ptr
  let count: number
  if (form === 'cc') count = compiled.symbols.count_entries(ffi.ptr(folder)) as number
  else if (form === 'linkSymbols')
    count = ffi
      .linkSymbols({ count_entries: { args: ['ptr'], returns: 'int', ptr: pointer } })
      .symbols.count_entries(ffi.ptr(folder)) as number
  else count = ffi.CFunction({ args: ['ptr'], returns: 'int', ptr: pointer })(ffi.ptr(folder)) as number
  result = `entries ${count}`
} else throw new Error(`unknown form ${form}`)

// The module's other exports still work.
console.log(JSON.stringify({ form, result, suffix, sameDlopen: dlopen === ffi.dlopen }))
