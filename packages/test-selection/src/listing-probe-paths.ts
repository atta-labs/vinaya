/**
 * What the listing probe (`listing-probe.ts`) and the recorder share, with nothing that runs on import: the probe's log
 * variable and the path helpers the probe logs folders through. The probe imports this module; the entrypoint exports
 * it, never the probe, whose import installs it.
 */
import { isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The environment variable naming the file the probe appends its lines to. */
export const PROBE_LOG_ENV = 'VINAYA_LISTING_PROBE_LOG'

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
