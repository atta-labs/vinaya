/**
 * `@harness/kernel/*` and `@harness/workflow/*` resolve everywhere a file is type-checked, run, tested or built: the
 * shared base config and the root config carry the same table, each of the kernel, workflow and CLI folders type-checks,
 * runs, tests and bundles an aliased import, and the CLI build leaves no alias specifier in anything it writes.
 *
 * Bun ignores `paths` reached through the package-name form of `extends`, so each folder config extends the base by a
 * relative path; these tests prove it by running Bun, not by the type check alone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')
const baseConfigPath = join(repoRoot, 'packages', 'typescript-config', 'base.json')
const rootConfigPath = join(repoRoot, 'tsconfig.json')
const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc')
const SLOW_MS = 180_000

const FOLDERS = [
  { name: 'kernel', dir: join(repoRoot, 'harness', 'kernel') },
  { name: 'workflow', dir: join(repoRoot, 'harness', 'processes', 'vinaya-strict') },
  { name: 'cli', dir: join(repoRoot, 'apps', 'cli') }
]
const probeOf = (dir: string): string => join(dir, 'tests', 'fixtures', 'alias-probe.ts')
const PROBE_OUTPUT = { kernel: 'pull.json', workflow: 6 }

/**
 * Inside the repository, in its git-ignored `out/` folder: Node finds the packages a bundle leaves external, `tsc` finds
 * `@types`, and Bun reads the configs written here (it skips any folder named `node_modules`).
 */
const scratch = join(repoRoot, 'out', `alias-resolution-${process.pid}-${Date.now()}`)

type Run = { exitCode: number; stdout: string; stderr: string }
async function run(cmd: string[], cwd: string): Promise<Run> {
  const child = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  return { exitCode, stdout, stderr }
}

function readPaths(configPath: string): Record<string, string[]> {
  const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
  }
  return parsed.compilerOptions?.paths ?? {}
}

/** Each alias with its absolute targets; `paths` resolve against the declaring file (no `baseUrl`) or the root `baseUrl`. */
function resolveTable(configPath: string): Record<string, string[]> {
  const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as { compilerOptions?: { baseUrl?: string } }
  const base = resolve(dirname(configPath), parsed.compilerOptions?.baseUrl ?? '.')
  return Object.fromEntries(
    Object.entries(readPaths(configPath)).map(([alias, targets]) => [
      alias,
      targets.map((target) => resolve(base, target))
    ])
  )
}

beforeAll(() => {
  mkdirSync(scratch, { recursive: true })
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('the alias tables', () => {
  test('the base config and the root config name the same folders (O4)', () => {
    const base = resolveTable(baseConfigPath)
    const root = resolveTable(rootConfigPath)
    expect(Object.keys(base).sort()).toEqual(Object.keys(root).sort())
    expect(base).toEqual(root)
  })

  test('every alias entry names something that exists, and both harness aliases are present (O4)', () => {
    const base = resolveTable(baseConfigPath)
    expect(Object.keys(base)).toContain('@harness/kernel/*')
    expect(Object.keys(base)).toContain('@harness/workflow/*')
    for (const [alias, targets] of Object.entries(base)) {
      for (const target of targets) {
        const path = alias.endsWith('/*') ? target.replace(/\/\*$/, '') : target
        expect({ alias, exists: existsSync(path) }).toEqual({ alias, exists: true })
      }
    }
    expect(base['@harness/kernel/*']).toEqual([join(repoRoot, 'harness', 'kernel', '*')])
    expect(base['@harness/workflow/*']).toEqual([join(repoRoot, 'harness', 'processes', 'vinaya-strict', '*')])
  })

  test('each folder config extends the base by a relative path, which Bun follows', () => {
    for (const folder of FOLDERS) {
      const config = JSON.parse(readFileSync(join(folder.dir, 'tsconfig.json'), 'utf-8')) as { extends: string }
      expect(config.extends.startsWith('.')).toBe(true)
      expect(resolve(folder.dir, config.extends)).toBe(baseConfigPath)
    }
  })
})

describe.each(FOLDERS)('the $name folder', (folder) => {
  const probe = probeOf(folder.dir)

  test(
    'type-checks an aliased import and reports a misspelt alias path as a missing module (O1)',
    async () => {
      const dir = join(scratch, `tsc-${folder.name}`)
      mkdirSync(dir, { recursive: true })
      const misspelt = join(dir, 'misspelt.ts')
      writeFileSync(
        misspelt,
        "import { PULL_FILE } from '@harness/kernel/adapters/code-host/github/forge-snapshott'\nexport const x = PULL_FILE\n"
      )
      const config = (file: string): string => {
        const path = join(dir, `${file}.tsconfig.json`)
        writeFileSync(
          path,
          JSON.stringify({
            extends: join(folder.dir, 'tsconfig.json'),
            compilerOptions: { noEmit: true, incremental: false },
            include: [],
            files: [file === 'good' ? probe : misspelt]
          })
        )
        return path
      }
      const good = await run([tsc, '-p', config('good')], repoRoot)
      expect({ code: good.exitCode, out: good.stdout }).toEqual({ code: 0, out: '' })
      const bad = await run([tsc, '-p', config('bad')], repoRoot)
      expect(bad.exitCode).not.toBe(0)
      expect(bad.stdout).toContain('TS2307')
      expect(bad.stdout).toContain('forge-snapshott')
    },
    SLOW_MS
  )

  test(
    'runs, tests and bundles an aliased import from the repository root and from each folder (O2)',
    async () => {
      const dir = join(scratch, `run-${folder.name}`)
      mkdirSync(dir, { recursive: true })
      // `bun test` file beside a config that extends this folder's: Bun reads the nearest config of the file it loads.
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ extends: relative(dir, join(folder.dir, 'tsconfig.json')) })
      )
      writeFileSync(
        join(dir, 'alias.test.ts'),
        [
          "import { expect, test } from 'bun:test'",
          "import { PULL_FILE } from '@harness/kernel/adapters/code-host/github/forge-snapshot'",
          "import { CI_SHARD_COUNT } from '@harness/workflow/checks/ci-shard-membership'",
          "test('alias', () => { expect([PULL_FILE, CI_SHARD_COUNT]).toEqual(['pull.json', 6]) })"
        ].join('\n')
      )
      let bundle = 0
      for (const cwd of [repoRoot, ...FOLDERS.map((other) => other.dir)]) {
        const where = relative(repoRoot, cwd) || '<root>'
        const ran = await run(['bun', 'run', probe], cwd)
        expect({ where, code: ran.exitCode, out: JSON.parse(ran.stdout.trim() || 'null') }).toEqual({
          where,
          code: 0,
          out: PROBE_OUTPUT
        })

        const tested = await run(['bun', 'test', join(dir, 'alias.test.ts')], cwd)
        expect({ where, code: tested.exitCode, err: tested.exitCode === 0 ? '' : tested.stderr }).toEqual({
          where,
          code: 0,
          err: ''
        })

        const outfile = join(dir, `bundle-${bundle++}.js`)
        const built = await run(['bun', 'build', probe, '--target=node', '--outfile', outfile], cwd)
        expect({ where, code: built.exitCode, err: built.exitCode === 0 ? '' : built.stderr }).toEqual({
          where,
          code: 0,
          err: ''
        })
        expect(readFileSync(outfile, 'utf-8')).not.toContain('@harness/')
        const underNode = await run(['node', outfile], cwd)
        expect({ where, code: underNode.exitCode, out: JSON.parse(underNode.stdout.trim() || 'null') }).toEqual({
          where,
          code: 0,
          out: PROBE_OUTPUT
        })
      }
    },
    SLOW_MS * 2
  )
})

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

describe('the CLI build with an aliased module (O3)', () => {
  const out = join(scratch, 'cli-build')
  const cliProbe = probeOf(join(repoRoot, 'apps', 'cli'))
  let build: Run

  beforeAll(async () => {
    mkdirSync(out, { recursive: true })
    build = await run(
      ['bun', join(repoRoot, 'apps', 'cli', 'scripts', 'build.ts'), '--out', out, '--probe', cliProbe],
      repoRoot
    )
  }, SLOW_MS * 2)

  test(
    'builds with no missing-module error',
    () => {
      expect({ code: build.exitCode, err: build.stderr }).toEqual({
        code: 0,
        err: expect.not.stringContaining('TS2307')
      })
      expect(build.stdout + build.stderr).not.toContain('TS2307')
    },
    SLOW_MS
  )

  test(
    'writes bundles, check bins and declarations that hold no alias specifier, the probe declaration among them',
    () => {
      const probeDeclaration = join(out, 'dist', 'types', relative(repoRoot, cliProbe).replace(/\.ts$/, '.d.ts'))
      expect(existsSync(probeDeclaration)).toBe(true)
      expect(existsSync(join(out, 'dist', 'probe', 'alias-probe.js'))).toBe(true)
      expect(existsSync(join(out, 'dist', 'checks', 'bin'))).toBe(true)
      const holders = filesUnder(out).filter((file) => readFileSync(file, 'utf-8').includes('@harness/'))
      expect(holders).toEqual([])

      // The declaration re-exports a value and a type from each alias, and each re-export resolves from the package.
      const declaration = readFileSync(probeDeclaration, 'utf-8')
      expect(declaration).toContain('PULL_FILE')
      expect(declaration).toContain('GhAuthor')
      expect(declaration).toContain('CI_SHARD_COUNT')
      expect(declaration).toContain('Task')
      const specifiers = [...declaration.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string)
      expect(specifiers.length).toBe(4)
      for (const specifier of specifiers) {
        expect(specifier.startsWith('.')).toBe(true)
        expect(existsSync(resolve(dirname(probeDeclaration), `${specifier}.d.ts`))).toBe(true)
      }
    },
    SLOW_MS
  )

  test(
    'emits a probe declaration that type-checks for a consumer',
    async () => {
      const probeDeclaration = join(out, 'dist', 'types', relative(repoRoot, cliProbe).replace(/\.ts$/, '.d.ts'))
      const consumerDir = join(scratch, 'consumer')
      mkdirSync(consumerDir, { recursive: true })
      const consumer = join(consumerDir, 'consumer.ts')
      writeFileSync(
        consumer,
        [
          `import { PULL_FILE, CI_SHARD_COUNT, type GhAuthor, type Task } from '${probeDeclaration.replace(/\.d\.ts$/, '')}'`,
          'export const file: string = PULL_FILE',
          'export const count: number = CI_SHARD_COUNT',
          'export const author: GhAuthor = null',
          'export const task: Task | undefined = undefined',
          'export const wrong: boolean = PULL_FILE',
          ''
        ].join('\n')
      )
      const config = join(consumerDir, 'tsconfig.json')
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: 'ESNext',
            moduleResolution: 'bundler',
            target: 'ES2022',
            skipLibCheck: true,
            types: ['node']
          },
          files: [consumer]
        })
      )
      const checked = await run([tsc, '-p', config], repoRoot)
      // Only the deliberately wrong line may fail: a lost re-export would add errors at the import line.
      const errors = checked.stdout.split('\n').filter((line) => line.includes('error TS'))
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('consumer.ts(6,')
      expect(errors[0]).toContain('TS2322')
    },
    SLOW_MS
  )

  test(
    'runs the probe bundle and the built CLI under Node, with the Log SDK still imported by name',
    async () => {
      const probe = await run(['node', join(out, 'dist', 'probe', 'alias-probe.js')], repoRoot)
      expect({ code: probe.exitCode, out: JSON.parse(probe.stdout.trim() || 'null') }).toEqual({
        code: 0,
        out: PROBE_OUTPUT
      })

      // The CLI reads its version from the package root above `dist/`.
      cpSync(join(repoRoot, 'apps', 'cli', 'package.json'), join(out, 'package.json'))
      const cli = join(out, 'dist', 'index.js')
      const bundled = readFileSync(cli, 'utf-8')
      expect(bundled).toMatch(/from ["']@attalabs\/vinaya-log-sdk["']/)
      expect(bundled).not.toContain('packages/log-sdk/src')

      const version = await run(['node', cli, 'version'], repoRoot)
      expect(version.exitCode).toBe(0)
      // `doctor` exits 1 when `gh` is not signed in; it must still print its report with no missing module.
      const doctor = await run(['node', cli, 'doctor', '--json'], repoRoot)
      expect([0, 1]).toContain(doctor.exitCode)
      expect(doctor.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/)
      expect(JSON.parse(doctor.stdout)).toHaveProperty('schema')
    },
    SLOW_MS
  )
})
