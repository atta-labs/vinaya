/**
 * Where the run's command-line program version comes from. The kernel cannot read the program's own manifest, so the
 * composition root registers a reader here, and the run recorder asks for the version when it opens a run's handle.
 * This module imports nothing, so registering a reader loads no logging code.
 */

let source: (() => string | undefined) | undefined

/** Registers how the program's own version is read; the latest registration wins. */
export function registerCliVersionSource(read: () => string | undefined): void {
  source = read
}

/** The program's version, or `undefined` when no reader is registered, it fails, or it names none. */
export function registeredCliVersion(): string | undefined {
  try {
    const version = source?.()
    return version === undefined || version === '' || version === 'unknown' ? undefined : version
  } catch {
    return undefined
  }
}
