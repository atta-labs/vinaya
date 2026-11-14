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
else throw new Error(`unknown form ${form}`)

// The module's other exports still work.
console.log(JSON.stringify({ form, result, suffix, sameDlopen: dlopen === ffi.dlopen }))
