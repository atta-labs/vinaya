/**
 * The listing probe: a Bun test preload the read recorder (`scripts/ci/record-reads.ts`) puts first in each traced
 * run's `[test] preload` list, so the record can tell a folder the test's own code listed from one Bun's module
 * resolver listed to find a module. A syscall trace cannot: both open the folder and read it with `getdents64`.
 *
 * The recorder copies this file into its scratch folder outside the repository and preloads the copy, so the probe
 * is never a read of the tests it watches. It writes one JSON line per event, synchronously, to the file the
 * `VINAYA_LISTING_PROBE_LOG` environment variable names, and does nothing when that is unset:
 *
 * - `{"pid":n,"start":true}` once per load (under `--isolate`, once per test file);
 * - `{"pid":n,"list":"/abs/folder","recursive":false}` before each folder-listing call of `node:fs` or its
 *   `promises` member runs — `readdir`, `opendir` and `glob` (a glob logs its pattern's static prefix), and
 *   `cp`, `rm` and `rmdir` given `recursive` — each wrapped in place on the object `require('node:fs')` returns, so
 *   named, namespace, default, `require`, `createRequire` and computed imports all reach the wrap;
 * - `{"pid":n,"whole":"<what>"}` on the first use of something whose listings the wrap cannot see: a worker (its
 *   modules load their own `fs`), Bun's Glob scan, shell, bundler or resolve functions (`Bun.resolve`, `Bun.resolveSync`), and native bindings, addons,
 *   libraries or compiled code (`process.dlopen`, and the `dlopen`, `cc`, `linkSymbols` and `CFunction` of `bun:ffi`).
 *   Each kind logs one line, on its first use. The recorder then
 *   counts every folder the process listed.
 *
 * Every wrap calls the original with the same receiver and arguments and returns what it returns.
 */
// `node:fs` is reached only through `require`: an ESM import of it here, before the wraps, would fix the named exports
// (and the namespace) every later ESM import of `node:fs` sees to the unwrapped functions.
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The environment variable naming the file the probe appends its lines to. */
export const PROBE_LOG_ENV = 'VINAYA_LISTING_PROBE_LOG'

type AnyFunction = (...args: unknown[]) => unknown
type Holder = Record<string, unknown>

const WRAPPED = Symbol.for('vinaya.listing-probe.wrapped')

/** A path argument as an absolute path: a `URL` or `file:` string to its file path, a relative path against the working folder. */
export function absoluteOf(path: unknown, base: string = process.cwd()): string | null {
  let text: string
  if (typeof path === 'string') text = path.startsWith('file:') ? fileURLToPath(path) : path
  else if (path instanceof URL) text = fileURLToPath(path)
  else if (path instanceof Uint8Array) text = Buffer.from(path).toString('utf8')
  else return null
  return isAbsolute(text) ? resolve(text) : resolve(base, text)
}

const MAGIC = /[*?[\]{}!()]/

/**
 * The folder a glob lists and whether it lists the folders beneath: the pattern's leading segments up to the first
 * that holds a wildcard, against `cwd`. A wildcard segment with more segments after it, or a `**`, reaches beneath.
 */
export function globPrefix(pattern: string, cwd: string): { folder: string; recursive: boolean } {
  const segments = pattern.split(/[\\/]/)
  const absolute = isAbsolute(pattern)
  const at = segments.findIndex((segment) => MAGIC.test(segment))
  if (at < 0) {
    // No wildcard: the glob looks up one path, in the folder holding it.
    const folder = segments.slice(0, -1).join('/')
    return { folder: absolute ? resolve(folder === '' ? sep : folder) : resolve(cwd, folder), recursive: false }
  }
  const prefix = segments.slice(0, at).join('/')
  const folder = absolute ? resolve(prefix === '' ? sep : prefix) : resolve(cwd, prefix)
  return { folder, recursive: at < segments.length - 1 || segments.slice(at).includes('**') }
}

function optionsOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !(value instanceof URL) && !(value instanceof Uint8Array)
    ? (value as Record<string, unknown>)
    : null
}

/** Installs the probe; returns false when no log is named. Safe to call again: a wrap is installed once per object. */
export function installListingProbe(log: string | undefined = process.env[PROBE_LOG_ENV]): boolean {
  if (!log) return false
  // The object `require('node:fs')` returns is shared by every import form and is writable; a namespace import's is not.
  const fs = require('node:fs') as Holder
  const appendFileSync = fs.appendFileSync as (file: string, text: string) => void
  const write = (line: Record<string, unknown>): void => {
    try {
      appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...line })}\n`)
    } catch {}
  }
  write({ start: true })
  const listed = (path: unknown, recursive: boolean): void => {
    try {
      const folder = absoluteOf(path)
      if (folder !== null) write({ list: folder, recursive })
    } catch {}
  }
  // One line per kind, on its first use: the recorder needs only one, and each names what reached past the wrap.
  const wholeLogged = new Set<string>()
  const whole = (what: string): void => {
    if (wholeLogged.has(what)) return
    wholeLogged.add(what)
    write({ whole: what })
  }
  const wrap = (holder: Holder, name: string, before: (args: unknown[]) => void): void => {
    const original = holder[name]
    if (typeof original !== 'function' || (original as unknown as Holder)[WRAPPED as unknown as string]) return
    const fn = original as AnyFunction
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      try {
        before(args)
      } catch {}
      return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args)
    }
    Object.defineProperties(wrapped, {
      name: { value: fn.name },
      length: { value: fn.length },
      [WRAPPED]: { value: true }
    })
    if (fn.prototype !== undefined) wrapped.prototype = fn.prototype
    for (const key of Reflect.ownKeys(fn))
      if (!(key in wrapped)) {
        const d = Object.getOwnPropertyDescriptor(fn, key)
        if (d) Object.defineProperty(wrapped, key, d)
      }
    holder[name] = wrapped
  }

  const listing = (args: unknown[]): void => {
    listed(args[0], optionsOf(args[1])?.recursive === true)
  }
  const recursiveOnly = (args: unknown[]): void => {
    // `cp(src, dest, options)` and `rm(path, options)`: only a recursive call walks a folder.
    const opts = optionsOf(args[2]) ?? optionsOf(args[1])
    if (opts?.recursive === true) listed(args[0], true)
  }
  const globbing = (args: unknown[]): void => {
    const opts = optionsOf(args[1])
    const cwd = opts?.cwd === undefined ? process.cwd() : (absoluteOf(opts.cwd) ?? process.cwd())
    const patterns = Array.isArray(args[0]) ? args[0] : [args[0]]
    for (const pattern of patterns) {
      if (typeof pattern !== 'string') continue
      const { folder, recursive } = globPrefix(pattern, cwd)
      write({ list: folder, recursive })
    }
  }

  const targets: [Holder, string[]][] = [[fs, ['readdir', 'readdirSync', 'opendir', 'opendirSync']]]
  const promises = fs.promises as Holder | undefined
  if (promises) targets.push([promises, ['readdir', 'opendir']])
  for (const [holder, names] of targets) for (const name of names) wrap(holder, name, listing)
  for (const holder of [fs, promises]) {
    if (!holder) continue
    for (const name of ['glob', 'globSync']) wrap(holder, name, globbing)
    for (const name of ['cp', 'cpSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync']) wrap(holder, name, recursiveOnly)
  }

  // What lists folders out of the wrap's sight marks the whole process.
  const g = globalThis as unknown as Holder
  wrap(g, 'Worker', () => whole('Worker'))
  const workers = require('node:worker_threads') as Holder
  wrap(workers, 'Worker', () => whole('worker_threads.Worker'))
  const proc = process as unknown as Holder
  for (const name of ['binding', '_linkedBinding', 'dlopen']) wrap(proc, name, () => whole(`process.${name}`))
  const bun = (globalThis as { Bun?: Holder }).Bun
  if (bun) {
    const glob = bun.Glob as { prototype?: Holder } | undefined
    if (glob?.prototype)
      for (const name of ['scan', 'scanSync']) wrap(glob.prototype, name, () => whole(`Glob.${name}`))
    wrap(bun, 'build', () => whole('Bun.build'))
    // Bun's resolve functions find a specifier from the resolver's own folder listings, which the trace cannot tell from
    // a module load's. Replaced in place on the global `Bun` before any test module loads, so `Bun.resolveSync(...)` and
    // `import { resolveSync } from 'bun'` alike reach the wrap.
    for (const name of ['resolve', 'resolveSync']) wrap(bun, name, () => whole(`Bun.${name}`))
    // The foreign-function module's native entry points run code out of the wrap's sight: `dlopen` loads a library,
    // `cc` compiles C (its compiler reads includes, and the code it builds can list folders), `linkSymbols` and
    // `CFunction` call native pointers. Replaced on the one object `require('bun:ffi')` returns, which every import form
    // of the module shares, so its other exports stay as they were.
    try {
      const ffi = require('bun:ffi') as Holder
      for (const name of ['dlopen', 'cc', 'linkSymbols', 'CFunction']) wrap(ffi, name, () => whole(`bun:ffi.${name}`))
    } catch {}
    const shell = bun.$ as AnyFunction | undefined
    if (typeof shell === 'function' && !(shell as unknown as Holder)[WRAPPED as unknown as string]) {
      // A Proxy keeps the shell's helper members (`$.cwd`, `$.escape`, `$.nothrow`, ...) working as before.
      bun.$ = new Proxy(shell, {
        apply(target, receiver, args) {
          whole('Bun.$')
          return Reflect.apply(target, receiver, args)
        },
        get(target, key, receiver) {
          return key === WRAPPED ? true : Reflect.get(target, key, receiver)
        }
      })
    }
  }
  return true
}

/** The log a recorder names for one traced test file. */
export const probeLogPath = (scratch: string, index: number): string => join(scratch, `${index}.probe.jsonl`)

installListingProbe()
