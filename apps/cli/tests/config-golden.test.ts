/**
 * The configuration golden: for every configuration in the corpus — the
 * repository's own `vinaya.config.json`, every tracked `vinaya.config*.json`
 * fixture, and every configuration value the configuration tests parse
 * (`fixtures/config-golden/corpus.json`) — whether the schema accepts it, the
 * exact issues and text it refuses with, the parsed value it accepts, and what
 * every exported resolver returns for it. `fixtures/config-golden/snapshot.json`
 * holds the recorded answer; this test fails on any difference, so a change to
 * how the schema is assembled can never change one accepted value, one refusal
 * or the order its issues are reported in.
 *
 * `CONFIG_GOLDEN_WRITE=1` rewrites the snapshot from the current schema. It is
 * for a deliberate change to the configuration's behaviour, reviewed as one.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  decisionRecordsPathIssue,
  isDefaultedAgentVendorPath,
  lintEnvDeclarations,
  loadTrustAnchorConfig,
  resolveAgentVendors,
  resolveCollisionThreshold,
  resolveGateCutovers,
  resolveLogsHeaderValues,
  resolveLogsSetting,
  resolveReleaseActor,
  resolveReviewPolicy,
  resolveRuntimeDirSetting,
  resolveSecurityScanCommand,
  resolveTaskRunner,
  resolveTrustAnchorLogsDestination,
  resolveTrustAnchorRuntimeDir,
  resolveTrustedPrincipals,
  type VinayaConfig,
  VinayaConfigSchema,
  VinayaConfigShape
} from '../src/lib/config.js'

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..')
const GOLDEN_DIR = join(import.meta.dir, 'fixtures', 'config-golden')
const SNAPSHOT_PATH = join(GOLDEN_DIR, 'snapshot.json')

const VENDOR_PATHS = [
  '.claude/commands/vinaya.md',
  '.gemini/commands/vinaya.toml',
  '.agents/skills/vinaya-developer/SKILL.md',
  '.claude/skills/vinaya-developer/SKILL.md',
  'README.md'
]
const HEADER_ENV = { VINAYA_LOG_TOKEN: 'write-token', VINAYA_LOG_READ_TOKEN: 'read-token' }

/** A resolver's answer, or the text it refuses with. */
function attempt(run: () => unknown): unknown {
  try {
    const value = run()
    return { value: value instanceof Set ? [...value] : (value ?? null) }
  } catch (err) {
    const kind = (err as { kind?: string }).kind
    return { error: (err as Error).message, ...(kind ? { kind } : {}) }
  }
}

/** What a trust-anchor read prints while it resolves, kept with its answer. */
function withStdout(run: () => unknown): { result: unknown; stdout: string } {
  const original = process.stdout.write.bind(process.stdout)
  let stdout = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
    return true
  }) as typeof process.stdout.write
  try {
    return { result: attempt(run), stdout }
  } finally {
    process.stdout.write = original
  }
}

function resolved(config: VinayaConfig): Record<string, unknown> {
  const anchored = () => Buffer.from(JSON.stringify(config), 'utf-8').toString('base64')
  const logs = resolveLogsSetting(config)
  const decisionPath = config.decisionRecords?.path
  return {
    resolveReviewPolicy: attempt(() => resolveReviewPolicy(config)),
    resolveGateCutovers: attempt(() => resolveGateCutovers(config)),
    resolveCollisionThreshold: attempt(() => resolveCollisionThreshold(config)),
    resolveReleaseActor: attempt(() => resolveReleaseActor(config)),
    resolveSecurityScanCommand: attempt(() => resolveSecurityScanCommand(config)),
    resolveRuntimeDirSetting: attempt(() => resolveRuntimeDirSetting(config)),
    resolveTrustAnchorRuntimeDir: attempt(() =>
      resolveTrustAnchorRuntimeDir(resolveRuntimeDirSetting(config) ?? '/elsewhere', config)
    ),
    resolveLogsSetting: attempt(() => logs),
    resolveTrustAnchorLogsDestination: attempt(() =>
      resolveTrustAnchorLogsDestination(logs ?? { folder: '/elsewhere' }, config)
    ),
    resolveLogsHeaderValues: attempt(() =>
      resolveLogsHeaderValues(config.logs ? config.logs.headers : undefined, HEADER_ENV)
    ),
    resolveAgentVendors: attempt(() => resolveAgentVendors(config.managed)),
    isDefaultedAgentVendorPath: attempt(() =>
      VENDOR_PATHS.map((path) => isDefaultedAgentVendorPath(path, config.managed ?? {}))
    ),
    resolveTaskRunner: attempt(() => resolveTaskRunner(undefined, config)),
    lintEnvDeclarations: attempt(() => lintEnvDeclarations(config.checks)),
    decisionRecordsPathIssue: attempt(() =>
      decisionPath === undefined ? null : decisionRecordsPathIssue(decisionPath, config.proseGates?.doctrineRoot)
    ),
    resolveTrustedPrincipals: attempt(() => resolveTrustedPrincipals(anchored)),
    loadTrustAnchorConfig: withStdout(() => loadTrustAnchorConfig(anchored))
  }
}

/** The schema's whole answer for one value. */
function golden(value: unknown): Record<string, unknown> {
  const parsed = VinayaConfigSchema.safeParse(value)
  if (!parsed.success) {
    return {
      accepted: false,
      issues: parsed.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })),
      detail: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    }
  }
  return { accepted: true, data: parsed.data, resolved: resolved(parsed.data) }
}

/** Every tracked `vinaya.config*.json`, the repository's own first. */
function trackedConfigFiles(): string[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPOSITORY_ROOT, encoding: 'utf-8' })
    .split('\0')
    .filter((path) => /(^|\/)vinaya\.config[^/]*\.json$/.test(path))
    .sort()
  return ['vinaya.config.json', ...files.filter((path) => path !== 'vinaya.config.json')]
}

function currentSnapshot(): Record<string, unknown> {
  const files: Record<string, unknown> = {}
  for (const path of trackedConfigFiles()) {
    files[path] = golden(JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), 'utf-8')))
  }
  const corpus = JSON.parse(readFileSync(join(GOLDEN_DIR, 'corpus.json'), 'utf-8')) as unknown[]
  return {
    shapeKeys: Object.keys(VinayaConfigShape),
    files,
    corpus: corpus.map((value) => ({ value, ...golden(value) }))
  }
}

// Every runtime export the configuration module had while it held the schema
// itself, plus the provider installer its composition roots call.
const CONFIG_MODULE_EXPORTS = [
  'BRIEF_BUILTINS',
  'GLOBAL_CONFIG_PATH',
  'GLOBAL_VINAYA_HOME',
  'LOCAL_CONFIG_FILENAME',
  'LOCAL_OVERRIDABLE_KEYS',
  'LOCAL_OVERRIDE_FILENAME',
  'MANAGED_MANIFEST_VERSION',
  'PRINCIPALS_FIX',
  'PrincipalsUnresolvedError',
  'VinayaConfigSchema',
  'VinayaConfigShape',
  'configPath',
  'decisionRecordsPathIssue',
  'getTokensCollectTrust',
  'gitBlobHash',
  'gitCommonDir',
  'globalChecksIgnoredWarning',
  'globalPrincipalsIgnoredWarning',
  'globalReleaseActorIgnoredWarning',
  'globalRolesIgnoredWarning',
  'globalRuntimeDirIgnoredWarning',
  'globalTokensCollectIgnoredWarning',
  'installVinayaConfigProvider',
  'isCanonicalHookBlockPath',
  'isDefaultedAgentVendorPath',
  'isSafeRepoRelPath',
  'lintEnvDeclarations',
  'loadConfig',
  'loadConfigChecked',
  'loadTaskRunner',
  'loadTrustAnchorConfig',
  'loadTrustAnchorConfigAsync',
  'loadTrustAnchorConfigOrThrow',
  'parseTokensCollectDeclaration',
  'readRepoCiSetup',
  'repoLocalConfigDir',
  'resolveAgentVendors',
  'resolveCiTrustAnchorProbeRef',
  'resolveCollisionThreshold',
  'resolveGateCutovers',
  'resolveLocalPacingOverride',
  'resolveLogsHeaderValues',
  'resolveLogsSetting',
  'resolveReleaseActor',
  'resolveReviewPolicy',
  'resolveRuntimeDirSetting',
  'resolveSecurityScanCommand',
  'resolveTaskRunner',
  'resolveTrustAnchorLogsDestination',
  'resolveTrustAnchorRuntimeDir',
  'resolveTrustedPrincipals',
  'tokensCollectTrustKey',
  'trustAnchorRepo',
  'trustAnchorRepoAsync',
  'trustTokensCollectCommand',
  'writeConfig'
]

describe('the configuration module', () => {
  test('exports every name it always exported', async () => {
    const module = await import('../src/lib/config.js')
    expect(Object.keys(module).sort()).toEqual([...CONFIG_MODULE_EXPORTS].sort())
  })

  test('its home and file names are unchanged', async () => {
    const { GLOBAL_CONFIG_PATH, GLOBAL_VINAYA_HOME, LOCAL_CONFIG_FILENAME } = await import('../src/lib/config.js')
    expect(GLOBAL_VINAYA_HOME).toBe(join(homedir(), '.vinaya'))
    expect(GLOBAL_CONFIG_PATH).toBe(join(homedir(), '.vinaya', 'config.json'))
    expect(LOCAL_CONFIG_FILENAME).toBe('vinaya.config.json')
  })

  test("installs Vinaya's composed loader as the provider kernel code reads through", async () => {
    const { GLOBAL_VINAYA_HOME, installVinayaConfigProvider, loadConfig } = await import('../src/lib/config.js')
    const { configProvider } = await import('../../../harness/kernel/config/loader/config-provider.js')
    installVinayaConfigProvider()
    expect(configProvider().homeDir).toBe(GLOBAL_VINAYA_HOME)
    expect(configProvider().loadConfig()).toEqual(loadConfig())
  })
})

describe('the configuration golden', () => {
  const current = currentSnapshot()
  if (process.env.CONFIG_GOLDEN_WRITE === '1') writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(current, null, 2)}\n`)
  const recorded = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8')) as Record<string, unknown>

  test('the configuration shape keeps its top-level keys, in order', () => {
    expect(current.shapeKeys).toEqual(recorded.shapeKeys)
  })

  test('every tracked configuration file is accepted, refused and resolved exactly as recorded', () => {
    expect(JSON.parse(JSON.stringify(current.files))).toEqual(recorded.files)
  })

  test('every configuration value the configuration tests parse is answered exactly as recorded', () => {
    expect(JSON.parse(JSON.stringify(current.corpus))).toEqual(recorded.corpus)
  })
})
