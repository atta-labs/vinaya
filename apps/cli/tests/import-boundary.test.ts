import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * One-way import boundary: the command line is a published package and must
 * never import another application of this repository (the portal, Studio, the
 * Log server and any application added later), whose internals are private.
 *
 * The guarded applications are read from the applications folder when the test
 * runs: every folder there with a `package.json`, other than the command line
 * itself, by its manifest's package name and by its folder. An import of one is
 * refused by its package name, by a subpath of that name, or by a relative path
 * that resolves into its folder.
 *
 * Scanned: the command line's `src/` and `tests/` folders. Its `scripts/`
 * folder is not part of the published package and is outside this scan.
 *
 * Matches import/export module specifiers only — never raw file text.
 */

const CLI_ROOT = join(import.meta.dir, '..')
const APPS_ROOT = join(CLI_ROOT, '..')
const SCAN_DIRS = [join(CLI_ROOT, 'src'), join(CLI_ROOT, 'tests')]

/** Another application of this repository: its manifest's package name and its folder. */
interface Application {
  name: string
  dir: string
}

/** Every application under the applications folder other than the command line, from its manifest. */
function readApplications(appsRoot: string, self: string): Application[] {
  const applications: Application[] = []
  for (const entry of readdirSync(appsRoot)) {
    const dir = join(appsRoot, entry)
    if (resolve(dir) === resolve(self)) continue
    const manifest = join(dir, 'package.json')
    if (!statSync(dir).isDirectory() || !existsSync(manifest)) continue
    const name = (JSON.parse(readFileSync(manifest, 'utf-8')) as { name?: unknown }).name
    if (typeof name !== 'string' || name.length === 0) throw new Error(`${manifest} names no package`)
    applications.push({ name, dir })
  }
  return applications.sort((a, b) => a.name.localeCompare(b.name))
}

const APPLICATIONS = readApplications(APPS_ROOT, CLI_ROOT)

// Matches `import ... from '<spec>'` / `export ... from '<spec>'`, including
// multi-line named-import blocks, anchored at the start of a source line.
const FROM_CLAUSE_RE = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*(['"])([^'"]+)\1/gm
// Matches bare `import '<spec>'` (no binding, no `from`).
const BARE_IMPORT_RE = /^\s*import\s*(['"])([^'"]+)\1/gm
// Matches dynamic `import('<spec>')` anywhere in the file.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g

interface Violation {
  file: string
  specifier: string
  application: string
}

function extractSpecifiers(source: string): string[] {
  const specifiers = new Set<string>()
  for (const re of [FROM_CLAUSE_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0
    let match = re.exec(source)
    while (match !== null) {
      specifiers.add(match[2] as string)
      match = re.exec(source)
    }
  }
  return [...specifiers]
}

/**
 * The application `specifier`, imported from the file `fromFile`, reaches into —
 * by its package name, a subpath of it, or a relative path resolving into its
 * folder — or `null` when it reaches into none.
 */
function applicationReached(specifier: string, fromFile: string, applications: Application[]): Application | null {
  for (const application of applications) {
    if (specifier === application.name || specifier.startsWith(`${application.name}/`)) return application
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(fromFile), specifier)
      const dir = resolve(application.dir)
      if (target === dir || target.startsWith(`${dir}${sep}`)) return application
    }
  }
  return null
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, files)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full)
    }
  }
  return files
}

function findViolations(roots: string[], applications: Application[]): Violation[] {
  const violations: Violation[] = []
  for (const root of roots) {
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf-8')
      for (const specifier of extractSpecifiers(source)) {
        const reached = applicationReached(specifier, file, applications)
        if (reached) violations.push({ file: relative(CLI_ROOT, file), specifier, application: reached.name })
      }
    }
  }
  return violations
}

/** A file inside the command line's source folder, the origin of every planted relative import. */
const PLANTED_FROM = join(CLI_ROOT, 'src', 'commands', 'planted.ts')

describe('import boundary: the command line must not import another application', () => {
  it('reads the other applications from their manifests, never the command line itself', () => {
    expect(APPLICATIONS.length).toBeGreaterThan(0)
    const cliName = (JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf-8')) as { name: string }).name
    expect(APPLICATIONS.map((a) => a.name)).not.toContain(cliName)
    for (const application of APPLICATIONS) {
      expect(resolve(dirname(application.dir))).toBe(resolve(APPS_ROOT))
      expect(existsSync(join(application.dir, 'package.json'))).toBe(true)
    }
  })

  for (const application of APPLICATIONS) {
    const folder = relative(APPS_ROOT, application.dir)

    it(`refuses an import of ${application.name} by name, by subpath and by relative path`, () => {
      expect(applicationReached(application.name, PLANTED_FROM, APPLICATIONS)).toBe(application)
      expect(applicationReached(`${application.name}/src/internal`, PLANTED_FROM, APPLICATIONS)).toBe(application)
      expect(applicationReached(`../../../${folder}/src/internal`, PLANTED_FROM, APPLICATIONS)).toBe(application)
      expect(applicationReached(`../../../${folder}`, PLANTED_FROM, APPLICATIONS)).toBe(application)
    })

    it(`finds a planted import of ${application.name} among a file's statements`, () => {
      const source = [
        `import { a } from '${application.name}'`,
        `export { b } from '${application.name}/src/b'`,
        `const c = await import('../../../${folder}/src/c')`
      ].join('\n')
      const reached = extractSpecifiers(source).map((s) => applicationReached(s, PLANTED_FROM, APPLICATIONS))
      expect(reached).toEqual([application, application, application])
    })
  }

  it('accepts the published Log SDK, the harness alias and relative paths inside the command line', () => {
    for (const specifier of [
      '@attalabs/vinaya-log-sdk',
      '@attalabs/vinaya-log-sdk/client',
      '@harness/kernel/gates/ops.js',
      '@harness/workflow/checks/registry',
      './sibling',
      '../lib/forge',
      '../../package.json',
      '../../tests/helpers'
    ]) {
      expect(applicationReached(specifier, PLANTED_FROM, APPLICATIONS)).toBeNull()
    }
  })

  it('does not take a name that only begins like an application name for it', () => {
    for (const application of APPLICATIONS) {
      const folder = relative(APPS_ROOT, application.dir)
      expect(applicationReached(`${application.name}-other`, PLANTED_FROM, APPLICATIONS)).toBeNull()
      expect(applicationReached(`../../../${folder}-other/src`, PLANTED_FROM, APPLICATIONS)).toBeNull()
    }
  })

  it('does not fire on prose or a looked-up path that names an application folder', () => {
    for (const application of APPLICATIONS) {
      const folder = relative(APPS_ROOT, application.dir)
      const src = `import 'server-only'\n/**\n * Served from '../../../${folder}/src' at run time.\n */\nconst dir = join(root, 'apps', '${folder}')\n`
      expect(extractSpecifiers(src).some((s) => applicationReached(s, PLANTED_FROM, APPLICATIONS) !== null)).toBe(false)
    }
  })

  it('scans the source folder and the tests folder, and not the scripts folder', () => {
    expect(SCAN_DIRS.map((d) => relative(CLI_ROOT, d))).toEqual(['src', 'tests'])
  })

  it('finds no import of another application in the source folder or the tests folder', () => {
    const violations = findViolations(SCAN_DIRS, APPLICATIONS)
    const message = violations.map((v) => `${v.file} imports '${v.specifier}' (${v.application})`).join('\n')
    expect(violations.length, `the command line imports another application:\n${message}`).toBe(0)
  })
})
