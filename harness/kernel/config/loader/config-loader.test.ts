import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  createConfigLoader,
  isMissingFileError,
  readLocalOverrideFile,
  resolveCiTrustAnchorProbeRef,
  schemaIssueDetail
} from './config-loader'

const LOCAL = 'kernel-loader-test.config.json'
const schema = z.object({ name: z.string().optional(), secret: z.string().optional(), size: z.number().optional() })
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf-8').toString('base64')

describe('the configuration loader', () => {
  let root: string
  let home: string
  let cwd: string
  let reports: string[]
  let loader: ReturnType<typeof createConfigLoader<typeof schema>>

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kernel-config-loader-')))
    home = join(root, 'home')
    mkdirSync(home)
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    mkdirSync(join(root, 'repo', 'nested', 'deeper'), { recursive: true })
    cwd = process.cwd()
    reports = []
    loader = createConfigLoader({
      schema,
      localFileName: LOCAL,
      homeDir: home,
      globalFileName: 'global.json',
      globalOnlyKeys: [
        { key: 'secret', present: (c) => Boolean(c.secret), warning: (path) => `${path}: secret is local-only` }
      ],
      reportInvalid: (path, detail) => reports.push(`${path} | ${detail}`),
      trustAnchorFallbackWarning: (why) => `fallback (${why})\n`,
      probeRefVariable: 'KERNEL_LOADER_TEST_PROBE_REF'
    })
  })

  afterEach(() => {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  })

  test('finds the local file walking up, never past the repository root, and falls back to the global file', () => {
    writeFileSync(join(root, LOCAL), JSON.stringify({ name: 'above' }))
    process.chdir(join(root, 'repo', 'nested', 'deeper'))
    expect(loader.configPath()).toBeNull()
    writeFileSync(join(home, 'global.json'), JSON.stringify({ name: 'global' }))
    expect(loader.loadConfig()).toEqual({ name: 'global' })
    writeFileSync(join(root, 'repo', 'nested', LOCAL), JSON.stringify({ name: 'local', secret: 's' }))
    expect(loader.loadConfig()).toEqual({ name: 'local', secret: 's' })
    expect(loader.repoLocalConfigDir()).toBe(join(root, 'repo', 'nested'))
  })

  test('strips a global-only key from the global file, warning once per process', () => {
    process.chdir(join(root, 'repo'))
    writeFileSync(join(home, 'global.json'), JSON.stringify({ name: 'g', secret: 's' }))
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(loader.loadConfig()).toEqual({ name: 'g', secret: undefined })
      expect(loader.loadConfigChecked()).toEqual({ ok: true, config: { name: 'g', secret: undefined } })
      expect(error.mock.calls).toEqual([[`⚠ ${join(home, 'global.json')}: secret is local-only`]])
    } finally {
      error.mockRestore()
    }
  })

  test('an invalid file reads as null and is reported once; the checked loader returns the detail', () => {
    process.chdir(join(root, 'repo'))
    writeFileSync(join(root, 'repo', LOCAL), JSON.stringify({ size: 'big' }))
    expect(loader.loadConfig()).toBeNull()
    expect(loader.loadConfig()).toBeNull()
    expect(reports).toEqual([`${join(root, 'repo', LOCAL)} | size: Expected number, received string`])
    expect(loader.loadConfigChecked()).toEqual({
      ok: false,
      path: join(root, 'repo', LOCAL),
      error: 'size: Expected number, received string'
    })
    const parsed = schema.safeParse({ size: 'big' })
    expect(parsed.success ? '' : schemaIssueDetail(parsed.error)).toBe('size: Expected number, received string')
  })

  test('the repository-root reader and the writer use the local file name', () => {
    loader.writeConfig('local', { name: 'written' }, join(root, 'repo'))
    expect(loader.readRepoConfig(join(root, 'repo'))).toEqual({ name: 'written' })
    expect(loader.readRepoConfig(root)).toBeNull()
  })

  test('the trust-anchor read parses, falls back with the named warning, and stays silent on a missing file', () => {
    const out = spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect(loader.loadTrustAnchorConfig(() => encode({ name: 'anchored' }))).toEqual({ name: 'anchored' })
      expect(loader.loadTrustAnchorConfig(() => encode({ size: 'big' }))).toBeNull()
      expect(loader.loadTrustAnchorConfig(() => Buffer.from('{', 'utf-8').toString('base64'))).toBeNull()
      expect(
        loader.loadTrustAnchorConfig(() => {
          throw new Error('Command failed: gh api\ngh: Not Found (HTTP 404)')
        })
      ).toBeNull()
      expect(out.mock.calls).toEqual([
        ['fallback (it did not satisfy the config schema)\n'],
        ['fallback (it was not readable as JSON)\n']
      ])
    } finally {
      out.mockRestore()
    }
  })

  test('the throwing variant rethrows a failed read and reads a missing file as null', async () => {
    expect(() =>
      loader.loadTrustAnchorConfigOrThrow(() => {
        throw new Error('rate limited')
      })
    ).toThrow('could not read the trust-anchor config from the default branch: rate limited')
    expect(
      loader.loadTrustAnchorConfigOrThrow(() => {
        throw new Error('HTTP 404')
      })
    ).toBeNull()
    expect(await loader.loadTrustAnchorConfigAsync(async () => encode({ name: 'a' }), { quiet: true })).toEqual({
      name: 'a'
    })
    expect(isMissingFileError({ message: 'Command failed', stderr: 'Not Found' })).toBe(true)
  })

  test('a local override is off while a suppressing variable is set', () => {
    process.env.KERNEL_LOADER_TEST_SUPPRESS = '1'
    try {
      expect(
        readLocalOverrideFile({
          fileName: 'x.json',
          overridableKeys: [],
          suppressedBy: ['KERNEL_LOADER_TEST_SUPPRESS']
        })
      ).toBeNull()
    } finally {
      delete process.env.KERNEL_LOADER_TEST_SUPPRESS
    }
  })
})

describe('the pre-merge probe ref', () => {
  const VARIABLE = 'KERNEL_LOADER_TEST_PROBE_REF'
  const job = { [VARIABLE]: ' refs/pr ', GITHUB_ACTIONS: 'true' }

  test('reads the variable the process names, only in a credential-free Actions job', () => {
    expect(resolveCiTrustAnchorProbeRef(job, VARIABLE)).toBe('refs/pr')
    expect(resolveCiTrustAnchorProbeRef(job, 'SOME_OTHER_VARIABLE')).toBeNull()
    expect(resolveCiTrustAnchorProbeRef({ ...job, GITHUB_ACTIONS: undefined }, VARIABLE)).toBeNull()
    expect(resolveCiTrustAnchorProbeRef({ ...job, GH_TOKEN: 'x' }, VARIABLE)).toBeNull()
    expect(resolveCiTrustAnchorProbeRef({ ...job, GITHUB_TOKEN: 'x' }, VARIABLE)).toBeNull()
  })
})
