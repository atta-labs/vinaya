import { isAbsolute } from 'node:path'
import { z } from 'zod'

// The kernel's configuration keys: the ones that name no process — checks and
// their environment declarations, enforcement rings, the managed-file
// manifest, continuous-integration setup, the task runner, where a run's
// files live and where the log is delivered. A process adds its own keys
// through a section (`process-config-section.ts`); the process's composition
// joins both into one object schema.
//
// A few leaves of these keys are names only a process knows: which agent
// vendors it installs entry points for, which folders its hook blocks may sit
// in, the grammar of its own log events, and any extra fields a check entry
// carries. `kernelConfigFragment` takes them as inputs, so the kernel holds the
// shape and the process supplies the names.

// `checks[*].env`: the per-check environment allowlist. `anyOf` requires at
// least two unique members — a single-member `anyOf` is `true` under another
// name. Load-time lint warnings over literal strings are `lintEnvDeclarations`'s,
// never the schema's: the schema validates shape, never content heuristics.
const EnvEntrySchema = z.union([
  z.literal(true),
  z.object({ optional: z.literal(true) }),
  z.object({ anyOf: z.array(z.string()).min(2) }),
  z.string()
])

/**
 * The fields every check entry carries, in the order the entry's object schema
 * reports them. A process inserts its own check fields at a named position
 * (`checkEntrySchema`), so the order an entry's issues are reported in stays one
 * fixed sequence.
 */
export const KERNEL_CHECK_ENTRY_FIELDS = {
  run: z.string(),
  scope: z.enum(['diff', 'full']),
  include: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().optional(),
  env: z.record(z.string(), EnvEntrySchema).optional(),
  requiresOpenPr: z.boolean().optional(),
  // A check whose own workflow reports it marks it here, so a full check run
  // stops producing a second conclusion nothing refreshes.
  ownWorkflow: z.boolean().optional(),
  // A check that validates a forge-write body or an Issue declares which.
  validates: z.enum(['body', 'issue']).optional(),
  // A warning-only check declares itself advisory; it changes nothing about how a run gates.
  advisory: z.literal(true).optional()
}

/**
 * One check entry's object schema: `fields` in their order, plus the `anyOf`
 * cross-reference no field can check alone — an `anyOf` declaration is keyed by
 * the variable it expands to, so the key must be one of its own members.
 */
export function checkEntrySchema<Fields extends z.ZodRawShape>(fields: Fields) {
  return z.object(fields).superRefine((entry, ctx) => {
    const env = (entry as { env?: Record<string, unknown> }).env
    if (!env) return
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'object' || value === null || !('anyOf' in value)) continue
      const members = (value as { anyOf: string[] }).anyOf
      if (new Set(members).size !== members.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `env.${key}.anyOf has duplicate members`,
          path: ['env', key, 'anyOf']
        })
      }
      if (!members.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `env.${key}.anyOf must include "${key}" itself as a member`,
          path: ['env', key, 'anyOf']
        })
      }
    }
  })
}

const HIGH_ENTROPY_MIN_LENGTH = 20

/** Loose heuristic, not a secret scanner: a long literal mixing char classes with no whitespace reads more like a pasted token than a hand-typed config value. */
function looksHighEntropy(value: string): boolean {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH) return false
  if (/\s/.test(value)) return false
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /[0-9]/.test(value)].filter(Boolean).length
  return classes >= 2
}

/**
 * Load-time lint warnings over `checks[*].env` literal-string forms — never a
 * schema-validation failure: a suspicious literal is still valid configuration,
 * so this is advisory and never a load-time refusal.
 */
export function lintEnvDeclarations(checks: Record<string, { env?: Record<string, unknown> }> | undefined): string[] {
  const warnings: string[] = []
  if (!checks) return warnings
  for (const [checkName, entry] of Object.entries(checks)) {
    if (!entry.env) continue
    for (const [key, value] of Object.entries(entry.env)) {
      if (typeof value !== 'string') continue
      if (value === 'true' || value === 'false') {
        warnings.push(
          `check "${checkName}" env.${key} is the literal string "${value}" — did you mean the boolean form \`${key}: true\` (forward the caller's value) rather than a hardcoded literal?`
        )
      } else if (looksHighEntropy(value)) {
        warnings.push(
          `check "${checkName}" env.${key} looks like a high-entropy literal (possible secret committed to config) — env declarations should reference variable NAMES the caller sets, not literal secret values.`
        )
      }
    }
  }
  return warnings
}

// `managed`: the ownership manifest an installer writes and its uninstaller
// reads, recording exactly what was created so it can be reversed precisely.
// `files` are whole-file paths the installer owns, `blocks` marker-delimited
// managed regions inside files the repository owns, `labels` the forge labels
// it created. Paths are repository-root-relative and forward-slashed.
//
// Version history: 1 — the original shape; 2 — written by a package that
// understands tracked hook folders routed through `core.hooksPath` (the shape
// is unchanged); 3 — the two ring flags' meaning was inverted, `true` now runs
// the ring. An upgrade reads this number, never the flags, to decide whether a
// configuration predates that change.
export const MANAGED_MANIFEST_VERSION = 3

/**
 * A recorded ownership path must be repository-root-relative and unable to
 * escape the repository — no absolute path, no `..` segment. The parse-layer
 * half of the uninstall-safety guarantee; the runtime containment check is the other.
 */
export function isSafeRepoRelPath(p: string): boolean {
  if (p.length === 0) return false
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return false // absolute
  return p.split(/[\\/]/).every((seg) => seg !== '..' && seg !== '')
}

const SafeRepoRelPath = z.string().refine(isSafeRepoRelPath, {
  message: 'must be a repo-root-relative path with no `..` segment or absolute root'
})

/**
 * The rule a managed block's path follows: it must start, byte-exactly and
 * case-sensitively, with one of `prefixes` and name something beneath it.
 * Refusing every other spelling at parse time means no block path outside those
 * folders ever reaches the code that resolves one.
 */
export function hookBlockPathRule(prefixes: readonly string[]) {
  const isCanonical = (p: string): boolean =>
    prefixes.some((prefix) => p.startsWith(prefix) && p.length > prefix.length)
  const schema = SafeRepoRelPath.refine(isCanonical, {
    message: `must start with one of ${prefixes.join(', ')} (byte-exact, case-sensitive)`
  })
  return { isCanonical, schema }
}

/** The names a process supplies for the kernel's keys. */
export type KernelConfigLeaves<
  Vendors extends Readonly<[string, ...string[]]>,
  Events extends z.ZodTypeAny,
  CheckFields extends z.ZodRawShape
> = {
  /** The agent vendors `managed.agents` may record. */
  agentVendors: Vendors
  /** The folders a managed block's path may start with. */
  hookBlockPrefixes: readonly string[]
  /** The grammar of `logs.events`. */
  logEvents: Events
  /** Every field of one check entry, in order: `KERNEL_CHECK_ENTRY_FIELDS` with any process fields placed among them. */
  checkEntryFields: CheckFields
}

/** The managed manifest's block record and manifest schemas for one set of leaves. */
export function managedManifestSchemas<Vendors extends Readonly<[string, ...string[]]>>(
  agentVendors: Vendors,
  hookBlockPrefixes: readonly string[]
) {
  const block = z.object({
    path: hookBlockPathRule(hookBlockPrefixes).schema,
    marker: z.string(),
    comment: z.enum(['hash', 'html'])
  })
  // `version` is a plain positive integer, never a literal of the current
  // version: an upgrade must read a manifest an older package wrote to migrate
  // it, or refuse one a newer package wrote with a message naming why.
  const manifest = z.object({
    version: z.number().int().positive(),
    files: z.array(SafeRepoRelPath),
    blocks: z.array(block),
    labels: z.array(z.string()),
    // The recorded agent-vendor selection. An explicit `[]` is a recorded
    // choice of none; an absent key is no recorded choice at all, which
    // `resolveAgentVendors` widens to every vendor.
    agents: z.array(z.enum(agentVendors)).optional()
  })
  return { block, manifest }
}

/**
 * The recorded agent-vendor selection as a set. An absent `agents` — a manifest
 * written before the selection was recorded — is every vendor, the same default
 * a fresh install uses; an explicit empty list stays empty.
 */
export function resolveAgentVendors<Vendor extends string>(
  manifest: { agents?: Vendor[] } | null | undefined,
  vendors: readonly Vendor[]
): Set<Vendor> {
  if (manifest?.agents === undefined) return new Set(vendors)
  return new Set(manifest.agents)
}

/** The `logs` key's schema for one log-event grammar. */
export function logsSchema<Events extends z.ZodTypeAny>(events: Events) {
  return z
    .object({
      // Must be absolute: each process would otherwise resolve a relative
      // folder against its own working directory.
      folder: z
        .string()
        .min(1)
        .refine((v) => isAbsolute(v), { message: 'logs.folder: must be an absolute path' })
        .optional(),
      url: z.string().url().optional(),
      // Header values may reference `${VAR_NAME}`, resolved at delivery time
      // (`resolveLogsHeaderValues`), so a credential never sits in the file.
      headers: z.record(z.string()).optional(),
      // The read credential, distinct from the write-only ingest `headers`;
      // the same `${VAR_NAME}` resolution.
      readHeaders: z.record(z.string()).optional(),
      // The repository's own log events, declared by name.
      events: events.optional()
    })
    .refine((v) => [v.folder, v.url].filter((x) => x !== undefined).length <= 1, {
      message: 'logs: set at most one of folder/url'
    })
    .refine((v) => v.headers === undefined || v.url !== undefined, {
      message: 'logs: headers requires url'
    })
    .refine((v) => v.readHeaders === undefined || v.url !== undefined, {
      message: 'logs: readHeaders requires url'
    })
    .or(z.literal(false))
    .optional()
}

/** The kernel's top-level keys, each the schema the composed configuration places under it. */
export function kernelConfigFragment<
  Vendors extends Readonly<[string, ...string[]]>,
  Events extends z.ZodTypeAny,
  CheckFields extends z.ZodRawShape
>(leaves: KernelConfigLeaves<Vendors, Events, CheckFields>) {
  return {
    // Declarative booleans only; ring 0 (git hooks) and the branch-protection
    // guarantee are never represented here.
    rings: z
      .object({
        ring1_forgeWriteInterception: z.boolean(),
        ring2_asyncAudits: z.boolean()
      })
      .optional(),
    // Custom-check registration: every entry produces the same check shape the
    // built-in registry does, with no privileged field on either side.
    checks: z.record(z.string(), checkEntrySchema(leaves.checkEntryFields)).optional(),
    managed: managedManifestSchemas(leaves.agentVendors, leaves.hookBlockPrefixes).manifest.optional(),
    // A shell command emitted verbatim as a step of the generated workflows
    // that run the repository's checks, read at generation time from the
    // repository-root file only. Absent, the workflows carry no setup step.
    ci: z.object({ setup: z.string().min(1) }).optional(),
    // Removed: telemetry never reaches a tracker or a code host. Kept as a
    // declared-but-refused key so a file still carrying it fails loudly,
    // naming its replacement, instead of being stripped in silence.
    logPublish: z.unknown().refine((v) => v === undefined, {
      message:
        'logPublish is removed — telemetry is never posted to a tracker or a code host; configure `logs` instead (a folder or a server destination)'
    }),
    // The one folder every file a task's run writes lives under. Must be
    // absolute; read only from the default branch by an unattended caller
    // (`resolveTrustAnchorRuntimeDir`).
    runtimeDir: z
      .string()
      .min(1)
      .refine((v) => isAbsolute(v), { message: 'runtimeDir: must be an absolute path' })
      .optional(),
    runner: z.enum(['standalone', 'atta-engine']).optional(),
    // Where the log delivers events live: a folder (the default when absent)
    // or a server, never both. Default-branch only for an unattended caller
    // (`resolveTrustAnchorLogsDestination`).
    logs: logsSchema(leaves.logEvents)
  }
}

/** The kernel's keys as one object, the leaves widened to what any process may supply. */
type WidestKernelFragment = ReturnType<
  typeof kernelConfigFragment<Readonly<[string, ...string[]]>, z.ZodType<unknown>, typeof KERNEL_CHECK_ENTRY_FIELDS>
>

/** The kernel's view of a parsed configuration: every kernel key, whatever process composed it. */
export type KernelConfig = z.infer<z.ZodObject<WidestKernelFragment>>

/** The kernel's top-level keys, in the order `kernelConfigFragment` declares them. */
export const KERNEL_CONFIG_KEYS = [
  'rings',
  'checks',
  'managed',
  'ci',
  'logPublish',
  'runtimeDir',
  'runner',
  'logs'
] as const satisfies readonly (keyof WidestKernelFragment)[]

/**
 * The kernel's cross-key refinements over a parsed configuration, run before
 * any section's. None spans two kernel keys today.
 */
export const KERNEL_CONFIG_REFINEMENTS: readonly ((config: KernelConfig, ctx: z.RefinementCtx) => void)[] = []

// ── Resolvers of the kernel's keys ──────────────────────────────────────────

/**
 * The working tree's own `runtimeDir` — `null` when unset. An attended caller
 * honours it directly; an unattended one puts it through
 * `resolveTrustAnchorRuntimeDir` first.
 */
export function resolveRuntimeDirSetting(config: Pick<KernelConfig, 'runtimeDir'> | null): string | null {
  return config?.runtimeDir ?? null
}

/**
 * The default-branch-approved `runtimeDir` for an unattended caller — `null`
 * unless the default branch's file declares the exact value the working tree
 * resolved. `null` means "fall back to the per-repository default", never
 * "honour the working tree anyway": a pull request must not redirect where
 * the run's control files live in its own diff.
 */
export function resolveTrustAnchorRuntimeDir(
  localRuntimeDir: string,
  trustAnchorConfig: Pick<KernelConfig, 'runtimeDir'> | null
): string | null {
  const anchored = resolveRuntimeDirSetting(trustAnchorConfig)
  return anchored !== null && anchored === localRuntimeDir ? anchored : null
}

/** Exactly one of `folder`/`url` — `config?.logs`'s resolved shape. */
export type LogsDestination = { folder: string } | { url: string; headers?: Record<string, string> }

/**
 * The working tree's own `logs` setting — `null` when unset, which means the
 * sink falls back to its own per-repository default folder. An unattended
 * caller puts it through `resolveTrustAnchorLogsDestination` first.
 */
export function resolveLogsSetting(config: Pick<KernelConfig, 'logs'> | null): LogsDestination | null {
  const raw = config?.logs
  if (!raw) return null
  if (raw.url !== undefined) return { url: raw.url, headers: raw.headers }
  if (raw.folder !== undefined) return { folder: raw.folder }
  return null
}

/**
 * The default-branch-approved `logs` destination for an unattended caller —
 * `null` unless the default branch's file declares the same destination the
 * working tree resolved. A server destination carries the default branch's own
 * `headers`, never the working tree's, so an edited header is caught the same
 * way an edited `url` is.
 */
export function resolveTrustAnchorLogsDestination(
  local: LogsDestination,
  trustAnchorConfig: Pick<KernelConfig, 'logs'> | null
): LogsDestination | null {
  const anchored = resolveLogsSetting(trustAnchorConfig)
  if (!anchored) return null
  if ('url' in local) return 'url' in anchored && anchored.url === local.url ? anchored : null
  return 'folder' in anchored && anchored.folder === local.folder ? anchored : null
}

/**
 * Substitutes `${VAR_NAME}` references in a `logs` header value with the named
 * environment variable. An unset variable resolves to the empty string, so a
 * missing credential surfaces as an authentication failure at the destination,
 * not a crashed sink. `undefined` in, `undefined` out.
 */
export function resolveLogsHeaderValues(
  headers: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv
): Record<string, string> | undefined {
  if (!headers) return undefined
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? '')
  }
  return resolved
}

export type TaskRunner = 'standalone' | 'atta-engine'

/** Selects the runner for one invocation; an absent setting keeps the standalone loop. */
export function resolveTaskRunner(
  override: string | undefined,
  config: Pick<KernelConfig, 'runner'> | null
): TaskRunner {
  const runner = override ?? config?.runner ?? 'standalone'
  if (runner !== 'standalone' && runner !== 'atta-engine') {
    throw new Error('runner: expected standalone or atta-engine')
  }
  return runner
}

export type ManagedBlockRecord = z.infer<
  ReturnType<typeof managedManifestSchemas<typeof import('../../adapters/agents/agent-vendors').AGENT_VENDORS>>['block']
>
export type ManagedManifest = z.infer<
  ReturnType<
    typeof managedManifestSchemas<typeof import('../../adapters/agents/agent-vendors').AGENT_VENDORS>
  >['manifest']
>
export type CheckEntry = z.infer<ReturnType<typeof checkEntrySchema<typeof KERNEL_CHECK_ENTRY_FIELDS>>>
