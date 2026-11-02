import { CustomEventDeclarationsSchema } from '@attalabs/aeg-core/log'
import { z } from 'zod'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../../../../../apps/cli/src/checks/contract.js'
import { AGENT_VENDORS, type AgentVendor } from '../../../../../apps/cli/src/lib/agent-vendors.js'
import {
  type ConfigLoadResult as KernelConfigLoadResult,
  createConfigLoader,
  gitCommonDir,
  resolveCiTrustAnchorProbeRef as kernelResolveCiTrustAnchorProbeRef,
  type TrustAnchorFetcher,
  trustAnchorRepo,
  trustAnchorRepoAsync
} from '../../../../kernel/config/loader/config-loader.js'
import { type ConfigProvider, installConfigProvider } from '../../../../kernel/config/loader/config-provider.js'
import {
  hookBlockPathRule,
  KERNEL_CHECK_ENTRY_FIELDS,
  KERNEL_CONFIG_REFINEMENTS,
  kernelConfigFragment,
  isSafeRepoRelPath,
  type LogsDestination,
  lintEnvDeclarations as kernelLintEnvDeclarations,
  MANAGED_MANIFEST_VERSION,
  managedManifestSchemas,
  resolveAgentVendors as kernelResolveAgentVendors,
  resolveLogsHeaderValues,
  resolveLogsSetting as kernelResolveLogsSetting,
  resolveRuntimeDirSetting as kernelResolveRuntimeDirSetting,
  resolveTaskRunner as kernelResolveTaskRunner,
  resolveTrustAnchorLogsDestination as kernelResolveTrustAnchorLogsDestination,
  resolveTrustAnchorRuntimeDir as kernelResolveTrustAnchorRuntimeDir,
  type TaskRunner
} from '../../../../kernel/config/schema/config-schema.js'
import { orderedShape } from '../../../../kernel/config/schema/process-config-section.js'
import {
  BRIEF_BUILTINS,
  type BriefBuiltin,
  type BriefSchema,
  type BriefSection,
  CANONICAL_HOOK_BLOCK_PREFIXES,
  createTrustedPrincipalsResolver,
  decisionRecordsPathIssue,
  getTokensCollectTrust,
  gitBlobHash,
  globalPrincipalsIgnoredWarning,
  globalReleaseActorIgnoredWarning,
  globalRolesIgnoredWarning,
  globalTokensCollectIgnoredWarning,
  isDefaultedAgentVendorPath,
  LOCAL_OVERRIDABLE_KEYS,
  LOCAL_OVERRIDE_FILENAME,
  type LocalPacingOverride,
  PRINCIPALS_FIX,
  type PrincipalsUnresolvedKind,
  PrincipalsUnresolvedError,
  type ProjectEntry,
  parseTokensCollectDeclaration,
  type RoleEntry,
  resolveCollisionThreshold as sectionResolveCollisionThreshold,
  resolveGateCutovers as sectionResolveGateCutovers,
  resolveLocalPacingOverride,
  resolveReleaseActor as sectionResolveReleaseActor,
  resolveReviewPolicy as sectionResolveReviewPolicy,
  resolveSecurityScanCommand as sectionResolveSecurityScanCommand,
  type TokensCollectDeclaration,
  type TokensCollectTrustEntry,
  type TokensCollectTrustStore,
  tokensCollectTrustKey,
  trustAnchorFallbackWarning,
  trustTokensCollectCommand,
  VINAYA_CHECK_ENTRY_FIELDS,
  VINAYA_CONFIG_FILENAME,
  VINAYA_CONFIG_SECTION,
  VINAYA_GLOBAL_CONFIG_FILENAME,
  VINAYA_GLOBAL_ONLY_KEYS,
  VINAYA_HOME
} from './vinaya-config-section.js'
import type { GateCutovers, ReviewPolicy } from '@attalabs/aeg-core'

// The composition of the kernel's configuration keys with Vinaya's section
// into the one schema `vinaya.config.json` is validated against, and the one
// loader that reads it. `apps/cli/src/lib/config.ts` re-exports what this
// module exports, under the names and types that module always had.
//
// The order below is the order the composed object schema reports a
// configuration's issues in. It is the order the keys were declared in when
// they were one schema, interleaving the two owners, so every refusal reads
// exactly as it did.

// One check entry's fields: the kernel's, with Vinaya's `principalOwed` after `ownWorkflow`.
const { validates, advisory, ...kernelCheckFieldsBeforeValidates } = KERNEL_CHECK_ENTRY_FIELDS
const CHECK_ENTRY_FIELDS = {
  ...kernelCheckFieldsBeforeValidates,
  ...VINAYA_CHECK_ENTRY_FIELDS,
  validates,
  advisory
}

const KERNEL_FRAGMENT = kernelConfigFragment({
  agentVendors: AGENT_VENDORS,
  hookBlockPrefixes: CANONICAL_HOOK_BLOCK_PREFIXES,
  logEvents: CustomEventDeclarationsSchema,
  checkEntryFields: CHECK_ENTRY_FIELDS
})

/** Every top-level key, kernel and Vinaya, in the order the composed schema declares them. */
export const CONFIG_KEY_ORDER = [
  'rings',
  'checks',
  'roles',
  'briefSchema',
  'managed',
  'principals',
  'releaseActor',
  'ci',
  'tokens',
  'blastRadius',
  'proseGates',
  'projects',
  'dispatch',
  'reviewPolicy',
  'securityScan',
  'gateCutovers',
  'planning',
  'prePush',
  'report',
  'logPublish',
  'runtimeDir',
  'runner',
  'logs',
  'decisionRecords'
] as const

const VinayaConfigObjectSchema = z.object(
  orderedShape<typeof KERNEL_FRAGMENT & typeof VINAYA_CONFIG_SECTION.fragment>(
    CONFIG_KEY_ORDER,
    KERNEL_FRAGMENT,
    VINAYA_CONFIG_SECTION.fragment
  )
)

/**
 * The configuration schema: the composed object, then every cross-key rule —
 * the kernel's, then Vinaya's — in one pass, so the issues they add keep one
 * order.
 */
export const VinayaConfigSchema = VinayaConfigObjectSchema.superRefine((config, ctx) => {
  for (const refine of KERNEL_CONFIG_REFINEMENTS) refine(config, ctx)
  for (const refine of VINAYA_CONFIG_SECTION.refinements) refine(config, ctx)
})

/** Every top-level key of the configuration, for introspection. */
export const VinayaConfigShape = VinayaConfigObjectSchema.shape

export type VinayaConfig = z.infer<typeof VinayaConfigSchema>

const CheckEntrySchema = VinayaConfigShape.checks.unwrap().valueSchema
export type CheckEntry = z.infer<typeof CheckEntrySchema>

const ManagedSchemas = managedManifestSchemas(AGENT_VENDORS, CANONICAL_HOOK_BLOCK_PREFIXES)
export type ManagedBlockRecord = z.infer<typeof ManagedSchemas.block>
export type ManagedManifest = z.infer<typeof ManagedSchemas.manifest>

const hookBlockPath = hookBlockPathRule(CANONICAL_HOOK_BLOCK_PREFIXES)

export function isCanonicalHookBlockPath(p: string): boolean {
  return hookBlockPath.isCanonical(p)
}

/** The persisted `--agents` selection as a set — every vendor when none was ever recorded. */
export function resolveAgentVendors(manifest: Pick<ManagedManifest, 'agents'> | null | undefined): Set<AgentVendor> {
  return kernelResolveAgentVendors(manifest, AGENT_VENDORS)
}

export const lintEnvDeclarations: (checks: Record<string, CheckEntry> | undefined) => string[] =
  kernelLintEnvDeclarations

// ── The machine-wide file's stripped keys, and the loader ──────────────────

export const GLOBAL_VINAYA_HOME = VINAYA_HOME
export const LOCAL_CONFIG_FILENAME = VINAYA_CONFIG_FILENAME

/** Shared with `vinaya doctor`'s permanent diagnostic so the load-time warning and the doctor finding say the same thing about one fact. */
export function globalChecksIgnoredWarning(path: string): string {
  return `${path}: "checks" registration in the global config is ignored — checks may only be registered from a repo-local vinaya.config.json.`
}

/**
 * `runtimeDir` is a folder, and the per-repository segment that keeps two
 * repositories' identically-numbered tasks apart is added only by
 * `defaultRuntimeDir`. Set machine-wide, every repository would share one
 * tree — one driver lock, one set of ownership epochs, one session file a
 * confined dispatch may read and write.
 */
export function globalRuntimeDirIgnoredWarning(path: string): string {
  return `${path}: "runtimeDir" in the global config is ignored — it carries no repository segment, so a machine-wide value would collapse every repository's task folders into one tree. Declare it from a repo-local vinaya.config.json.`
}

export {
  globalPrincipalsIgnoredWarning,
  globalReleaseActorIgnoredWarning,
  globalRolesIgnoredWarning,
  globalTokensCollectIgnoredWarning
}

/**
 * Inside a check the runner spawned (`VINAYA_CHECK_NAME` set), standard error
 * is the check-error channel: any non-JSON line there turns the check into a
 * malformed-output `error`. So there the report is one `warning` check-error
 * line naming that check — `warning`, because the check still runs, on
 * defaults. Elsewhere it is one line on standard error.
 */
function reportInvalidConfig(path: string, detail: string): void {
  const message = `${path} is not a valid Vinaya configuration (${detail}) — falling back to built-in defaults.`
  const checkName = process.env.VINAYA_CHECK_NAME
  if (checkName) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: checkName,
      severity: 'warning',
      message,
      agent_recovery_prompt: `Fix the failing keys in ${path} (${detail}) so the file parses and satisfies the configuration schema, then re-run.`,
      file: path
    })
    return
  }
  console.error(`⚠ ${message}`)
}

/** The environment variable the pre-merge probe job sets to its checked-out pull-request ref. */
const CI_CONFIG_PROBE_REF_VARIABLE = 'VINAYA_CI_CONFIG_PROBE_REF'

const loader = createConfigLoader({
  schema: VinayaConfigSchema,
  localFileName: VINAYA_CONFIG_FILENAME,
  homeDir: VINAYA_HOME,
  globalFileName: VINAYA_GLOBAL_CONFIG_FILENAME,
  // The order each key is checked and stripped in, kernel and Vinaya keys interleaved.
  globalOnlyKeys: [
    {
      key: 'checks',
      present: (config) => Boolean(config.checks && Object.keys(config.checks).length > 0),
      warning: globalChecksIgnoredWarning
    },
    VINAYA_GLOBAL_ONLY_KEYS.roles,
    VINAYA_GLOBAL_ONLY_KEYS.principals,
    VINAYA_GLOBAL_ONLY_KEYS.releaseActor,
    VINAYA_GLOBAL_ONLY_KEYS.tokens,
    { key: 'runtimeDir', present: (config) => Boolean(config.runtimeDir), warning: globalRuntimeDirIgnoredWarning }
  ],
  reportInvalid: reportInvalidConfig,
  trustAnchorFallbackWarning,
  probeRefVariable: CI_CONFIG_PROBE_REF_VARIABLE
})

export const GLOBAL_CONFIG_PATH = loader.globalConfigPath

/**
 * The pre-merge probe ref, or `null` — the trust-anchor read's one CI-only seam,
 * named by `VINAYA_CI_CONFIG_PROBE_REF` (`resolveCiTrustAnchorProbeRef` in the
 * kernel loader holds the rule).
 */
export function resolveCiTrustAnchorProbeRef(env: NodeJS.ProcessEnv = process.env): string | null {
  return kernelResolveCiTrustAnchorProbeRef(env, CI_CONFIG_PROBE_REF_VARIABLE)
}

export type ConfigLoadResult = KernelConfigLoadResult<VinayaConfig>

/**
 * The active config file: the repo-local `vinaya.config.json` (walking up from
 * the cwd, never past the enclosing repository's root), else the global
 * `~/.vinaya/config.json`, else `null`.
 */
export const configPath: () => string | null = loader.configPath

/**
 * Hierarchical config loader: the repo-local file, else the global one, else
 * `null`. An invalid file is reported once and read as `null`, so every caller
 * falls back to built-in defaults.
 */
export const loadConfig: () => VinayaConfig | null = loader.loadConfig

/**
 * Same hierarchical resolution as `loadConfig()`, but parse/validation
 * failures go back to the caller instead of `null` — used by `check` and task
 * runner selection, where a typo'd `checks` key must refuse, never print green.
 */
export const loadConfigChecked: () => ConfigLoadResult = loader.loadConfigChecked

/**
 * Writes config to `<repoRoot or cwd>/vinaya.config.json` ('local') or
 * `~/.vinaya/config.json` ('global').
 */
export const writeConfig: (scope: 'local' | 'global', config: VinayaConfig, repoRoot?: string) => void =
  loader.writeConfig

/** The directory holding this repo's own repo-local `vinaya.config.json`, or `null`. */
export const repoLocalConfigDir: () => string | null = loader.repoLocalConfigDir

/**
 * The `ci.setup` command declared by the REPO-ROOT config, or `null` — never
 * the cwd-walking `loadConfig()`. Any read or parse failure is `null`, the same
 * output as an undeclared key.
 */
export function readRepoCiSetup(repoRoot: string): string | null {
  return loader.readRepoConfig(repoRoot)?.ci?.setup ?? null
}

/**
 * The trust-anchor config — `vinaya.config.json` as it exists on the
 * repository's default branch per GitHub's own API, never the PR's checkout.
 * The ONLY sanctioned input to the resolvers of a trust-sensitive key
 * (`resolveReleaseActor`, `resolveReviewPolicy`). Every failure returns `null`.
 * `fetcher` is injectable for tests ONLY.
 */
export const loadTrustAnchorConfig: (fetcher?: TrustAnchorFetcher) => VinayaConfig | null = loader.loadTrustAnchorConfig

/** `loadTrustAnchorConfig`, but a genuine forge-read failure other than a missing file is re-thrown. */
export const loadTrustAnchorConfigOrThrow: (fetcher?: TrustAnchorFetcher) => VinayaConfig | null =
  loader.loadTrustAnchorConfigOrThrow

/** `loadTrustAnchorConfig` for a caller that must never block the event loop. */
export const loadTrustAnchorConfigAsync: (
  fetcher?: () => Promise<string>,
  options?: { quiet?: boolean }
) => Promise<VinayaConfig | null> = loader.loadTrustAnchorConfigAsync

/** The Principal list from the default branch's `principals`, with no fallback — see `createTrustedPrincipalsResolver`. */
export const resolveTrustedPrincipals: (fetcher?: TrustAnchorFetcher) => string[] = createTrustedPrincipalsResolver({
  fetch: loader.fetchTrustAnchorConfig,
  parse: loader.parseTrustAnchorContent
})

/** A malformed configuration must refuse a task start, even with a runner override. */
export function loadTaskRunner(override?: string): TaskRunner {
  const loaded = loadConfigChecked()
  if (!loaded.ok) throw new Error(`${loaded.path}: ${loaded.error}`)
  return resolveTaskRunner(override, loaded.config)
}

// ── Resolvers, under the types they always had ─────────────────────────────

export const resolveReleaseActor: (config: VinayaConfig | null) => string = sectionResolveReleaseActor
export const resolveReviewPolicy: (config: VinayaConfig | null) => ReviewPolicy = sectionResolveReviewPolicy
export const resolveSecurityScanCommand: (config: VinayaConfig | null) => readonly string[] | null =
  sectionResolveSecurityScanCommand
export const resolveGateCutovers: (config: VinayaConfig | null) => GateCutovers = sectionResolveGateCutovers
export const resolveCollisionThreshold: (config: VinayaConfig | null) => number = sectionResolveCollisionThreshold
export const resolveRuntimeDirSetting: (config: VinayaConfig | null) => string | null = kernelResolveRuntimeDirSetting
export const resolveTrustAnchorRuntimeDir: (
  localRuntimeDir: string,
  trustAnchorConfig: VinayaConfig | null
) => string | null = kernelResolveTrustAnchorRuntimeDir
export const resolveLogsSetting: (config: VinayaConfig | null) => LogsDestination | null = kernelResolveLogsSetting
export const resolveTrustAnchorLogsDestination: (
  local: LogsDestination,
  trustAnchorConfig: VinayaConfig | null
) => LogsDestination | null = kernelResolveTrustAnchorLogsDestination
export const resolveTaskRunner: (override: string | undefined, config: VinayaConfig | null) => TaskRunner =
  kernelResolveTaskRunner

export {
  BRIEF_BUILTINS,
  decisionRecordsPathIssue,
  getTokensCollectTrust,
  gitBlobHash,
  gitCommonDir,
  isDefaultedAgentVendorPath,
  isSafeRepoRelPath,
  LOCAL_OVERRIDABLE_KEYS,
  LOCAL_OVERRIDE_FILENAME,
  MANAGED_MANIFEST_VERSION,
  PRINCIPALS_FIX,
  PrincipalsUnresolvedError,
  parseTokensCollectDeclaration,
  resolveLocalPacingOverride,
  resolveLogsHeaderValues,
  tokensCollectTrustKey,
  trustAnchorRepo,
  trustAnchorRepoAsync,
  trustTokensCollectCommand
}

export type {
  BriefBuiltin,
  BriefSchema,
  BriefSection,
  LocalPacingOverride,
  LogsDestination,
  PrincipalsUnresolvedKind,
  ProjectEntry,
  RoleEntry,
  TaskRunner,
  TokensCollectDeclaration,
  TokensCollectTrustEntry,
  TokensCollectTrustStore,
  TrustAnchorFetcher
}

// ── The provider kernel code reads through ─────────────────────────────────

// Kernel readers in a program that holds this composition return `VinayaConfig`.
declare module '../../../../kernel/config/loader/config-provider.js' {
  interface ComposedConfigRegistry {
    config: VinayaConfig
  }
}

/** Vinaya's composed loader, as the provider kernel code reads configuration through. */
export const vinayaConfigProvider: ConfigProvider = {
  homeDir: VINAYA_HOME,
  loadConfig: () => loadConfig(),
  loadTrustAnchorConfig: () => loadTrustAnchorConfig(),
  loadTrustAnchorConfigAsync: (fetcher, options) => loadTrustAnchorConfigAsync(fetcher, options)
}

/**
 * Installs Vinaya's composed loader as the configuration provider. Each
 * composition root calls it before any command or run starts.
 */
export function installVinayaConfigProvider(): void {
  installConfigProvider(vinayaConfigProvider)
}

// Every program that composes Vinaya's configuration reads kernel
// configuration through it: a check program, a hook or a script the CLI
// spawns reaches this module through its own imports without passing through
// a composition root, and must not find the kernel's reads refused.
installVinayaConfigProvider()
