import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { DEFAULT_RELEASE_ACTOR, PRINCIPAL_ALLOWLIST } from '@attalabs/aeg-core'
import { AGENT_VENDORS, type AgentVendor } from './agent-vendors.js'
import { CLAUDE_COMMAND_PATH } from './claude-command-emitter.js'
import { GEMINI_COMMAND_PATH } from './gemini-command-emitter.js'

// Rings is the only schema surface this task ships — declarative
// booleans, no conditional logic. Ring 0 (git hooks) and the
// CI/branch-protection guarantee are never represented here, by design.
//
// `checks`: custom-check registration.
// Same discipline — globs (`include`) are permitted for SCOPING, conditionals
// (`if`/`unless`/`except`) are never part of this grammar. Any entry here
// produces the exact same `CheckSpec` shape the built-in registry does
// (`src/checks/registry.ts`) — no privileged field either side can carry.
// `env`: the per-check env-allowlist declaration (see `CheckSpec['env']` in
// `src/checks/contract.ts` for the full grammar). `anyOf` requires >= 2
// unique members — a single-member anyOf is just `true` under a different
// name and would only hide the simpler form. Load-time lint warnings (a
// literal `"true"`/`"false"` string, a high-entropy literal that looks like
// a leaked secret rather than a real config value) are the caller's
// responsibility (`loadConfigChecked`'s callers), not this schema — Zod
// validates SHAPE, never content heuristics.
const EnvEntrySchema = z.union([
  z.literal(true),
  z.object({ optional: z.literal(true) }),
  z.object({ anyOf: z.array(z.string()).min(2) }),
  z.string()
])

const CheckEntrySchema = z
  .object({
    run: z.string(),
    scope: z.enum(['diff', 'full']),
    include: z.array(z.string()).optional(),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().optional(),
    env: z.record(z.string(), EnvEntrySchema).optional(),
    requiresOpenPr: z.boolean().optional(),
    // Same no-privileged-field discipline as `env` and `requiresOpenPr`: a
    // config-registered check declares this exactly like a core one. An
    // adopter whose own workflow reports a check marks it here so
    // `check --all` stops producing a second conclusion nothing refreshes.
    ownWorkflow: z.boolean().optional()
  })
  // `anyOf` is keyed BY the variable name it expands to (`{"GITHUB_TOKEN":
  // {"anyOf":["GITHUB_TOKEN","GH_TOKEN"]}}`) — the key must be one of its own
  // members, or the declaration can never actually resolve to that key. Zod's
  // `record` validates each value's shape but has no cross-reference to its
  // own key, hence this refine pass on top.
  .superRefine((entry, ctx) => {
    if (!entry.env) return
    for (const [key, value] of Object.entries(entry.env)) {
      if (typeof value !== 'object' || value === null || !('anyOf' in value)) continue
      const members = value.anyOf
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

export type CheckEntry = z.infer<typeof CheckEntrySchema>

// `roles`: per-role override and additive-role registration, keyed by
// config key. `contract` is PATH-ONLY, resolved relative to this config
// file's own directory — a slash-free value (e.g. `"developer.md"`) is
// rejected at load, so the field can never be confused for a bare role id
// or a shell command the way `checks.run` legitimately can be. The
// resolver (`src/roles/resolver.ts`) does the override-vs-additive
// classification and structural contract validation; this schema only
// proves the shape is a path.
const RoleEntrySchema = z.object({
  contract: z.string().refine((p) => p.includes('/'), {
    message: 'must be a path (contain at least one "/"), not a bare filename'
  })
})
export type RoleEntry = z.infer<typeof RoleEntrySchema>

const HIGH_ENTROPY_MIN_LENGTH = 20

/** Loose heuristic, not a secret scanner: a long literal mixing char classes with no whitespace reads more like a pasted token than a hand-typed config value. */
function looksHighEntropy(value: string): boolean {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH) return false
  if (/\s/.test(value)) return false
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /[0-9]/.test(value)].filter(Boolean).length
  return classes >= 2
}

/**
 * Load-time lint warnings over `checks[*].env` literal-string forms — never
 * a schema-validation failure (a suspicious literal is still valid config;
 * this is advisory, surfaced by `vinaya check`'s warn output and `vinaya
 * doctor`, never a load-time refusal).
 */
export function lintEnvDeclarations(checks: Record<string, CheckEntry> | undefined): string[] {
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

// briefSchema: the config-defined brief schema
// the forge-write commands validate a body against. WHICH sections a `pr`/
// `issue` body must carry is expressed HERE, never hardcoded in the command
// code — this repo's required-section set is just one instance (one
// derivation, N consumers). Declarative only: a section is either a named
// battle-tested built-in (backed by an `@attalabs/aeg-core` validator) or a
// generic heading/field/phrase matcher an adopter authors for their own
// required sections. No conditional grammar (no if/unless/except) —
// any diff-conditionality (lock-ack, premise coverage) lives inside the
// built-in validator's code, never in this config.
export const BRIEF_BUILTINS = [
  'tier',
  'testPlan',
  'testPlanExclusivity',
  'principalPlaceholder',
  'surfaceMap',
  'docUpdateList',
  'worktreeStep0',
  'stopConditions',
  'autonomyClause',
  'project',
  'for',
  'closesN',
  'premiseCoverage',
  'issueRationale',
  'objectives',
  'briefSections',
  'milestoneShape'
] as const
export type BriefBuiltin = (typeof BRIEF_BUILTINS)[number]

// A single required section. Discriminated by which key is present:
//   { "builtin": "tier" }             — run the named aeg-core validator
//   { "heading": "Rollback Plan" }    — require a matching `## …` heading
//   { "field": "Ticket" }             — require a `Ticket:` header field
//   { "phrase": "signed-off-by" }     — require a literal phrase anywhere
// `name` is an optional human label for the custom-matcher forms.
const BriefSectionSchema = z.union([
  z.object({ builtin: z.enum(BRIEF_BUILTINS) }),
  z.object({ heading: z.string().min(1), name: z.string().optional() }),
  z.object({ field: z.string().min(1), name: z.string().optional() }),
  z.object({ phrase: z.string().min(1), name: z.string().optional() })
])
export type BriefSection = z.infer<typeof BriefSectionSchema>

const BriefSchemaSchema = z.object({
  pr: z.object({ sections: z.array(BriefSectionSchema) }).optional(),
  issue: z.object({ sections: z.array(BriefSectionSchema) }).optional(),
  // Same shape as pr/issue — an adopter's required sections for `vinaya
  // milestone create` bodies. `checkMilestoneShape`'s own goal/Release:/
  // intents refusal is unconditional (called directly by the command, not
  // config-gated, mirroring the Issue-only A/B/D content gate) — this key
  // only lets an adopter layer their own custom `heading`/`field`/`phrase`
  // sections on top, or opt into the `milestoneShape` builtin explicitly.
  milestone: z.object({ sections: z.array(BriefSectionSchema) }).optional(),
  // Builtins this adopter has DELIBERATELY dropped, by builtin name
  // (`closesN`, `tier`, …). Purely a silencer for `vinaya doctor`'s
  // brief-schema divergence report — it grants nothing and gates nothing, so
  // acking a builtin that is still present in `sections` changes no
  // behaviour anywhere. `briefSchema` is adopter-owned and `upgrade` never
  // rewrites it, which is correct; before this key existed, that ownership
  // also meant a dropped builtin was permanently invisible (#70). The report
  // makes the divergence visible; this makes a considered choice quiet while
  // an accidental one keeps surfacing.
  ack: z.array(z.enum(BRIEF_BUILTINS)).optional()
})
export type BriefSchema = z.infer<typeof BriefSchemaSchema>

// `managed`: the ownership manifest
// `vinaya init` writes and `vinaya eject` reads. It records exactly what the
// installer created so eject reverses it precisely — deleting only files it
// created, stripping only blocks it wrote (leaving adopter content), and
// reporting created labels for manual removal (never auto-deleting a label
// that may be in use elsewhere). `files` are whole-file paths vinaya owns;
// `blocks` are marker-delimited managed regions inside adopter-owned files;
// `labels` are the forge labels vinaya created-if-absent. Paths are
// repo-root-relative, forward-slashed. If this manifest is absent or corrupt
// at eject time, eject refuses rather than guessing at ownership.
//
// Version history:
//   1 — original shape; hooks recorded at `.husky/*` or `.git/hooks/*`.
//   2 — written by a package that understands the tracked-hooks layout
//       (atta-labs/attalabs#927: non-husky installs record hooks at
//       `.vinaya/hooks/*`, routed via `core.hooksPath`). The SHAPE is
//       unchanged, and 2 does NOT attest that THIS repo uses tracked hooks —
//       `upgrade` also writes 2 for husky installs and for installs whose
//       migration was refused; never key behavior off the version alone,
//       read the recorded block paths. What the bump buys is narrow: an
//       older package's `upgrade` (the only command with a version guard,
//       `manifest.version > MANAGED_MANIFEST_VERSION`) refuses a newer
//       manifest loudly instead of regenerating against locations it
//       half-understands. Released `doctor`/`eject` have no such guard — an
//       old-package eject of a migrated install removes the tracked hook
//       files but leaves `core.hooksPath` set (dangling but harmless: git
//       finds no hooks there and runs none).
export const MANAGED_MANIFEST_VERSION = 2

// A recorded ownership path must be a repo-root-relative path that cannot
// escape the repo — no absolute path, no `..` segment. This is the parse-layer
// half of the eject-safety guarantee: a hand-edited or malicious manifest
// carrying `../OUTSIDE` fails validation here, so `eject`'s readManifest sees a
// corrupt manifest and refuses rather than deleting outside the bounds each
// path kind is allowed (`containedAbs` for files, `containedManagedBlockAbs`
// for managed blocks — the latter bounded by the git common dir's `hooks/`
// subtree, which is outside `repoRoot` from a linked worktree). The
// runtime containment check in lib/ops.ts is the belt-and-suspenders half.
export function isSafeRepoRelPath(p: string): boolean {
  if (p.length === 0) return false
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return false // absolute
  return p.split(/[\\/]/).every((seg) => seg !== '..' && seg !== '')
}
const SafeRepoRelPath = z.string().refine(isSafeRepoRelPath, {
  message: 'must be a repo-root-relative path with no `..` segment or absolute root'
})

// The managed-block path spellings `buildInitOps` ever generates.
// `startsWith('.git/')` (lib/ops.ts's runtime discriminator) is a
// case-sensitive prefix test, and `.git` alone (no trailing slash) resolves
// to a real directory rather than a file — issue #177's amendment found both
// escape it, one via a case-insensitive filesystem, one on every filesystem.
// Rejecting any spelling that isn't byte-exactly one of these prefixes here,
// before a `ManagedManifest` can even exist, means lib/ops.ts's resolvers
// never see a bad `blocks[].path` again — this is the parse-layer half of
// that fix; lib/ops.ts's own discriminators are deliberately unchanged
// (belt-and-suspenders, not a second fix).
//
// `.claude/hooks/` (task 10, #278) is the fourth: the Claude Code Stop-hook
// script (`claude-stop-hook-emitter.ts`) is a marker-delimited managed block
// exactly like the three git-hook directories, just never `.git/`-prefixed —
// `containedManagedBlockAbs` (lib/ops.ts) only special-cases a `.git/`
// prefix for the shared-across-worktrees reasoning that does not apply here
// (a Claude Code settings/hooks tree is per-checkout), so it correctly falls
// through to ordinary `containedAbs` scoping for this new prefix.
const CANONICAL_HOOK_BLOCK_PREFIXES = ['.git/', '.husky/', '.vinaya/hooks/', '.claude/hooks/'] as const

export function isCanonicalHookBlockPath(p: string): boolean {
  return CANONICAL_HOOK_BLOCK_PREFIXES.some((prefix) => p.startsWith(prefix) && p.length > prefix.length)
}

const ManagedHookBlockPath = SafeRepoRelPath.refine(isCanonicalHookBlockPath, {
  message: `must start with one of ${CANONICAL_HOOK_BLOCK_PREFIXES.join(', ')} (byte-exact, case-sensitive)`
})

const ManagedBlockRecordSchema = z.object({
  path: ManagedHookBlockPath,
  marker: z.string(),
  comment: z.enum(['hash', 'html'])
})
export type ManagedBlockRecord = z.infer<typeof ManagedBlockRecordSchema>
// `version` is a plain positive integer, NOT `z.literal(MANAGED_MANIFEST_VERSION)`:
// `vinaya upgrade` must be able to READ a manifest recorded by an older
// package version to migrate it forward, or refuse with a self-explaining
// message when the manifest is NEWER than the installed package understands —
// an exact-literal pin would make either case a schema-parse failure instead
// of a real, diagnosable comparison.
const ManagedManifestSchema = z.object({
  version: z.number().int().positive(),
  files: z.array(SafeRepoRelPath),
  blocks: z.array(ManagedBlockRecordSchema),
  labels: z.array(z.string()),
  // The `vinaya init --agents` vendor selection (task 5, #152) — which of the
  // three agent-native emitters (tasks 2/3/4) this repo opted into. Persisted
  // so `upgrade`/`doctor` read an EXPLICIT selection back rather than
  // re-deriving a default: a repo initialized with `--agents=claude` must not
  // have a flagless `vinaya upgrade` silently add the other vendors' files,
  // nor silently drop the recorded selection. `--agents=none` writes a real
  // `agents: []` (an empty array is still a value — `writeManifest`'s plain
  // `JSON.stringify` never drops it), genuinely distinct on disk from a
  // manifest written before this key existed at all, where the field is
  // simply absent (`undefined`). `resolveAgentVendors` below relies on that
  // distinction: `undefined` is not a recorded choice, it is amnesia — an
  // adopter who has never seen this flag must get the same default a fresh
  // `vinaya init` gives everyone else, every `upgrade`, without ever being
  // told to re-run `init` by hand (found live: attalabs' own pre-existing
  // install silently never got `.claude/commands/vinaya.md` this way).
  agents: z.array(z.enum(AGENT_VENDORS)).optional()
})
export type ManagedManifest = z.infer<typeof ManagedManifestSchema>

const AGENTS_SKILLS_PREFIX = '.agents/skills/'

/**
 * `true` for the three agent-vendor file paths, but ONLY when the manifest
 * has never recorded any `--agents` choice at all (`agents === undefined`,
 * same condition `resolveAgentVendors` below widens to every vendor for).
 * `upgrade`'s `planUpgrade` and `doctor`'s `diagnoseInstall` both gate a
 * `create-file` op on a SEPARATE `manifest.files` ownership list, unrelated
 * to `agents` — without this, `resolveAgentVendors` correctly resolving to
 * every vendor still would not get these three files past that second gate,
 * since `manifest.files` never listed them for an install predating the
 * feature. This is the shared other half both callers need; kept beside
 * `resolveAgentVendors` so the two conditions can never drift apart.
 */
export function isDefaultedAgentVendorPath(path: string, manifest: Pick<ManagedManifest, 'agents'>): boolean {
  if (manifest.agents !== undefined) return false
  return path === CLAUDE_COMMAND_PATH || path === GEMINI_COMMAND_PATH || path.startsWith(AGENTS_SKILLS_PREFIX)
}

/**
 * The persisted `--agents` selection as a Set. `undefined` (the key was
 * never written — a manifest predating this feature) defaults to every
 * vendor, the same default `vinaya init` itself uses for a fresh install:
 * new capability reaches an existing adopter through `upgrade` alone, the
 * same as it would through `init`. An explicit `agents: []` (from
 * `--agents=none`) is a real, recorded choice and is returned empty exactly
 * as declared — never widened back to the default.
 */
export function resolveAgentVendors(manifest: Pick<ManagedManifest, 'agents'> | null | undefined): Set<AgentVendor> {
  if (manifest?.agents === undefined) return new Set(AGENT_VENDORS)
  return new Set(manifest.agents)
}

// `projects`: a config-native home for project metadata, alongside (not
// instead of) `.vinaya/projects.md` (`registry-write.ts`'s `PROJECTS_REGISTRY_PATH`).
// `init product <name>` appends an entry here at the same time it appends the
// registry row — see `registry-write.ts`'s `planConfigProjectEntry`/
// `applyConfigProjectEntry`, the config-side sibling of `planRegistryRow`/
// `applyRegistryRow`. Minimal metadata only, matching the config grammar's
// declarative discipline: `name` identifies the entry (dedup key, mirrors the
// registry row's own `Project` column); `description`/`path` are optional
// display metadata. Never load-bearing for enforcement — no gate or resolver
// reads this key, exactly like the registry file it sits beside.
const ProjectEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  path: z.string().min(1).optional()
})
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>

/** A parsed `tokens.collect` declaration — see `tokens.collect`'s own schema comment. */
export type TokensCollectDeclaration = { interpreter: string; script: string }

/**
 * Parses a `tokens.collect` string into its two required parts, or `null`
 * if the string is not shaped that way. Deliberately RIGID, not a shell
 * tokenizer: exactly one interpreter token, one script-path token, nothing
 * else — no flags, no quoting, no `&&`/`|`/`;`, no extra arguments. This is
 * what makes the round-3 content-pinning fix (`tokens.collect trust cache`,
 * below) rigorous rather than heuristic: there is exactly one file this
 * declaration can ever mean, identified by parsing alone, never by
 * guessing which whitespace-delimited token of an otherwise-arbitrary
 * shell string "looks like a path" (security review, PR #303, round 3 —
 * that guessing was the earlier design this one replaces).
 *
 * The script segment must additionally satisfy `isSafeRepoRelPath` — no
 * absolute path, no `..` segment — since it is later resolved relative to
 * this repo-local config file's own directory, exactly like
 * `RoleEntrySchema.contract`'s resolution.
 */
export function parseTokensCollectDeclaration(value: string): TokensCollectDeclaration | null {
  const m = value.trim().match(/^(\S+)\s+(\S+)$/)
  if (!m) return null
  const [, interpreter, script] = m as [string, string, string]
  if (!isSafeRepoRelPath(script)) return null
  return { interpreter, script }
}

export const VinayaConfigSchema = z.object({
  rings: z
    .object({
      ring1_forgeWriteInterception: z.boolean(),
      ring2_asyncAudits: z.boolean()
    })
    .optional(),
  checks: z.record(z.string(), CheckEntrySchema).optional(),
  roles: z.record(z.string(), RoleEntrySchema).optional(),
  briefSchema: BriefSchemaSchema.optional(),
  managed: ManagedManifestSchema.optional(),
  // GitHub logins trusted as this repo's own principals for review-gate
  // verdict-author verification and actor-verified waiver labels
  // (`vinaya/waiver:docs`, `vinaya/waiver:review`) — overrides the hardcoded
  // `PRINCIPAL_ALLOWLIST` (this monorepo's own principal) when set. Repo-local
  // only, same as `checks` — stripped from a global config below, since who
  // counts as a trusted approver must come from the reviewed, committed
  // per-repo file, never a machine-wide personal config.
  principals: z.array(z.string()).min(1).optional(),
  // The GitHub login expected to author this repo's Changesets release PR
  // (`changeset-release/main`) — overrides `DEFAULT_RELEASE_ACTOR`
  // (`github-actions[bot]`, the stock `changesets/action` + ambient
  // `GITHUB_TOKEN` identity) when this repo opens release PRs some other
  // way, e.g. a custom PAT (`RELEASE_TOKEN`) whose owner is a real user
  // login, not a bot. Same trust class as `principals` — repo-local only,
  // resolved via the same server-side trust-anchor read
  // (`resolveReleaseActor` + `loadTrustAnchorConfig`), never from local git
  // or an env var: this value gates the Changesets-release exemption on
  // `body-bare-digits`, a merge-authority decision.
  releaseActor: z.string().min(1).optional(),
  // Adopter-declared CI preparation. `ci.setup` is a shell command emitted
  // verbatim as a step in the generated workflows that execute
  // `vinaya check` — the only generated jobs that can spawn the ADOPTER'S
  // OWN custom-check scripts, which live in the adopter's repo and may
  // import the adopter's code. `npx` prepares only vinaya itself; vinaya
  // cannot know an adopter's package manager or runtime, so this is
  // declared, never inferred. Absent, the generated workflows are
  // byte-identical to before this key existed. Read at GENERATION time
  // (`init`/`upgrade`/`doctor`) from the repo-root config only
  // (`readRepoCiSetup`) — a global config's `ci` is never consulted.
  ci: z.object({ setup: z.string().min(1) }).optional(),
  // Adopter-declared token-usage collection for `vinaya tokens`
  // (`aeg-root/tranche-model.md` §12 layer 2), for a non-Claude-Code host —
  // whose stdout must be a JSON object shaped `{ inputTokens, outputTokens,
  // cacheCreationInputTokens, cacheReadInputTokens, model }` — the
  // `TranscriptSummary` seam flattened to JSON. Absent, `vinaya tokens`
  // falls back to the shipped Claude Code transcript adapter unchanged —
  // this key is a pure ADDITION of a second route, never a replacement of
  // the first, and the shipped adapter is never removed when this key is
  // present.
  //
  // This is an opt-in collection route, not a capability declaration:
  // `resolveMeteringCapability`'s probe stays host-identity-blind exactly as
  // ruled (Principal, 2026-08-28) — there is no `tokens.metering` key, and
  // this key is read only inside `vinaya tokens`'s own command path, never
  // consulted by the probe `vinaya doctor`/`vinaya upgrade` call.
  //
  // Read from the repo-root config only, same trust class as `checks` and
  // `principals`: a value that decides what runs on this turn must come
  // from the reviewed, committed per-repo file, never a machine-wide
  // personal config — stripped from a global config below with a loud
  // warning, never resolved.
  //
  // GRAMMAR (round 3, security review PR #303): exactly
  // `"<interpreter> <repo-relative-script-path>"` — two whitespace-
  // delimited tokens, nothing else. `parseTokensCollectDeclaration`
  // (above) is the one parser; no flags, no shell syntax (`&&`/`|`/`;`),
  // no quoting are ever part of this grammar, and the script segment must
  // satisfy `isSafeRepoRelPath`. This is deliberately RIGID, replacing an
  // earlier, more permissive "any shell command" shape two rounds of
  // security review found real holes in:
  //   - Round 1: an arbitrary shell command ran with no printed trace at
  //     all. Fixed: `vinaya tokens` prints the exact command to stderr
  //     immediately before every run (`tokens.ts`) — an audit trail, never
  //     a gate on its own.
  //   - Round 2: a printed trace is not a gate — nothing stopped a
  //     malicious or mistaken value from running the first time anyone ran
  //     `vinaya tokens`. Fixed: `vinaya tokens` REFUSES to run at all until
  //     a human has explicitly approved it, per exact declaration, per
  //     repo, per machine, via `vinaya tokens --trust-collect`
  //     (`tokens.collect trust cache`, below).
  //   - Round 3: trust from round 2 bound to the command STRING alone,
  //     never to the CONTENT of the script it invoked — editing only the
  //     script, never this config, executed the new content silently on
  //     the next run. Closed by narrowing the grammar itself (this
  //     comment): the interpreter/script split is exact, never heuristic,
  //     so the ONE file a declaration can mean is always identifiable, and
  //     trust now pins that file's content (a real `git hash-object` blob
  //     hash) alongside the declaration. Spawned via `execFile` — never a
  //     shell — closing the earlier "shell interpretation" surface as a
  //     side effect of the narrower grammar, not a separate fix.
  tokens: z
    .object({
      collect: z
        .string()
        .min(1)
        .refine((v) => parseTokensCollectDeclaration(v) !== null, {
          message:
            'tokens.collect must be exactly "<interpreter> <repo-relative-script-path>" — two whitespace-separated tokens, no flags, no shell syntax, no quoting'
        })
    })
    .optional(),
  // The sanctioned "I need one more blast-radius collision domain" path —
  // the legacy `.aeg/packages` static file is retired, zero backward
  // compatibility, so this is now the ONLY way to declare one beyond
  // derivation. `checkBlastRadiusScope`'s domain list
  // (`apps/cli/src/lib/forge-write.ts`'s `readSharedPackages`, mirroring
  // `packages/aeg-core/bin/open-issue.ts`'s own) is live-derived from
  // `package.json` workspaces plus a built-in cross-cutting default set
  // (lockfile, monorepo config, CI, git hooks); an adopter who needs a
  // domain beyond those (a `migrations/` folder, a codegen output dir)
  // declares it here.
  blastRadius: z.object({ extraDomains: z.array(z.string()).optional() }).optional(),
  // De-hardcodes `reader-resolvable-prose`/`retired-vocabulary`'s repo-specific
  // inputs (task 7, Issue #56) — the two prose/vocabulary core checks read
  // this key at check-run time (`check-reader-resolvable-prose.ts`,
  // `check-retired-vocabulary.ts`), never at generation time, so editing it
  // takes effect on the very next `vinaya check` with no `upgrade` needed.
  // Every field is optional and additive: an adopter who sets nothing gets
  // this repo's own prior hardcoded defaults (`doctrineRoot: 'aeg-root'`, a
  // dormant reader-facing sweep, `legacySlugDir` derived from `doctrineRoot`).
  proseGates: z
    .object({
      // The doctrine directory these checks sweep in full (`ships` class) —
      // `aeg-root/**` by default, this repo's own doctrine root. An adopter
      // who names their installed doctrine tree differently sets this once;
      // both checks read it the same way.
      doctrineRoot: z.string().min(1).optional(),
      // The reader-facing surface's path prefix and filename suffix — e.g.
      // `apps/web/src/app` and `/page.tsx`. BOTH must be set together for the
      // reader-facing sweep to run at all; either absent (the default) is a
      // declared no-op, matching this repo's own `READER_FACING_ROOT: null`
      // (no public site here to sweep), not a silent gap.
      readerFacingPrefix: z.string().min(1).optional(),
      readerFacingSuffix: z.string().min(1).optional(),
      // The archived-tranche directory `checkUnresolvableReferences`'s
      // legacy-slug list is derived from (filenames, not content). Defaults
      // to `<doctrineRoot>/tranches/completed`; absent-on-disk degrades to
      // an explicitly dormant legacy-slug class, never an error.
      legacySlugDir: z.string().min(1).optional()
    })
    .optional(),
  // Config-native project metadata — see the `ProjectEntrySchema` comment
  // above. Additive-only; absent entirely for a single-project repo.
  projects: z.array(ProjectEntrySchema).optional(),
  // `vinaya dispatch <role> --agent <vendor>` (task 3, `vinaya-log-v1`,
  // `apps/cli/src/lib/dispatch.ts`). `timeoutMs` is the wall-time ceiling
  // before `dispatchRole` sends `SIGTERM` (then `SIGKILL`) to the child;
  // absent defaults to one hour (`DEFAULT_TIMEOUT_MS` in `dispatch.ts`).
  // `agent` is a default vendor the CLI's own `--agent` flag overrides, for a
  // repo that always dispatches the same vendor.
  //
  // The three vendor names are duplicated here as a literal enum rather than
  // imported from `./dispatch.js`'s `AGENT_VENDOR_NAMES`: `dispatch.ts`
  // itself calls `loadConfig()` (this file) to resolve `dispatch.timeoutMs`,
  // so importing the other direction would make the two files circular. The
  // list is fixed at three and reviewed alongside any change to
  // `dispatch.ts`'s own `AgentVendor` union, which stays the source of truth
  // for the type.
  dispatch: z
    .object({
      timeoutMs: z.number().int().positive().optional(),
      agent: z.enum(['claude', 'codex', 'gemini']).optional()
    })
    .optional()
})

export type VinayaConfig = z.infer<typeof VinayaConfigSchema>

const GLOBAL_VINAYA_HOME = join(homedir(), '.vinaya')
const GLOBAL_CONFIG_PATH = join(GLOBAL_VINAYA_HOME, 'config.json')
const LOCAL_CONFIG_FILENAME = 'vinaya.config.json'

/**
 * Walk up from cwd looking for vinaya.config.json. Returns null if not found.
 *
 * The walk never crosses the enclosing repository's own root (`.git` is a
 * directory in a primary checkout, a gitlink file in a linked worktree —
 * existsSync covers both). "Repo-local" is this file's own trust boundary —
 * `checks`/`principals` are stripped from the GLOBAL config precisely
 * because trust must come from the reviewed, committed repo file — but the
 * unbounded walk didn't enforce it: a planted vinaya.config.json in a
 * world-writable ancestor (`/tmp`) would register `checks.*.run` commands
 * that the check engine then executes, in every generated pre-commit hook
 * (security review, PR #94, same class as studio.ts's walk). Outside any
 * git repository the walk still reaches the filesystem root, unchanged —
 * that keeps `vinaya check` usable in non-git trees; the bound bites only
 * where a repository boundary exists to honor. A config that sits ABOVE the
 * repo it governs no longer resolves — that shape was never "repo-local",
 * and the global-config fallback in `configPath()` still applies.
 */
function findLocalConfig(): string | null {
  let dir = process.cwd()
  while (true) {
    const candidate = join(dir, LOCAL_CONFIG_FILENAME)
    if (existsSync(candidate)) return candidate
    if (existsSync(join(dir, '.git'))) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Returns the path to the active config file:
 * - Repo-local vinaya.config.json (if found in parent hierarchy)
 * - Global ~/.vinaya/config.json
 * - null if neither exists
 */
export function configPath(): string | null {
  const local = findLocalConfig()
  if (local) return local
  if (existsSync(GLOBAL_CONFIG_PATH)) return GLOBAL_CONFIG_PATH
  return null
}

/**
 * Shared with `vinaya doctor`'s permanent diagnostic (Part 4) so the
 * stderr-at-load-time warning and the doctor finding can never say something
 * different about the same fact.
 */
export function globalChecksIgnoredWarning(path: string): string {
  return `${path}: "checks" registration in the global config is ignored — checks may only be registered from a repo-local vinaya.config.json.`
}

/** Same reasoning as `globalChecksIgnoredWarning` — a trust decision must come from the reviewed, committed repo file, never a machine-wide personal config. */
export function globalPrincipalsIgnoredWarning(path: string): string {
  return `${path}: "principals" in the global config is ignored — principals may only be declared from a repo-local vinaya.config.json.`
}

/** Same reasoning as `globalChecksIgnoredWarning` — a role contract is agent-facing doctrine, and which one a role name resolves to must come from the reviewed, committed repo file, never a machine-wide personal config. */
export function globalRolesIgnoredWarning(path: string): string {
  return `${path}: "roles" registration in the global config is ignored — roles may only be registered from a repo-local vinaya.config.json.`
}

/** Same reasoning as `globalPrincipalsIgnoredWarning` — `releaseActor` gates a merge-authority exemption, same trust class as `principals`. */
export function globalReleaseActorIgnoredWarning(path: string): string {
  return `${path}: "releaseActor" in the global config is ignored — releaseActor may only be declared from a repo-local vinaya.config.json.`
}

/** Same reasoning as `globalChecksIgnoredWarning` — `tokens.collect` decides what command runs on this turn, and that decision must come from the reviewed, committed repo file, never a machine-wide personal config. */
export function globalTokensCollectIgnoredWarning(path: string): string {
  return `${path}: "tokens" in the global config is ignored — tokens.collect may only be declared from a repo-local vinaya.config.json.`
}

/**
 * `checks` and `principals` from the global config are both explicitly out
 * of scope for it (`checks`: spec chapter, "Explicitly out of scope for this
 * design"; `principals`: a trust decision, same reasoning as
 * `globalPrincipalsIgnoredWarning`) — both stripped at config-*loading* time,
 * never resolved, each with its own loud warning naming the file. This is
 * what keeps the resolver itself source-blind: it takes one `config`
 * parameter with no notion of "this came from global vs. local," because
 * every caller already sees an already-stripped config.
 *
 * `roles` is stripped the same way, for the same trust reason: a role
 * contract's frontmatter (`description`, `refuses_when`, `performs`, …) is
 * consumed as agent-facing doctrine — `vinaya doctrine --role` hands it to
 * a third-party agent tool as operating instructions — so which contract a
 * role name resolves to must come from the reviewed, committed repo file,
 * never a machine-wide personal config.
 */
function stripGlobalOnlyKeys(config: VinayaConfig, path: string): VinayaConfig {
  if (path !== GLOBAL_CONFIG_PATH) return config
  let result = config
  if (result.checks && Object.keys(result.checks).length > 0) {
    console.error(`⚠ ${globalChecksIgnoredWarning(path)}`)
    result = { ...result, checks: undefined }
  }
  if (result.roles && Object.keys(result.roles).length > 0) {
    console.error(`⚠ ${globalRolesIgnoredWarning(path)}`)
    result = { ...result, roles: undefined }
  }
  if (result.principals && result.principals.length > 0) {
    console.error(`⚠ ${globalPrincipalsIgnoredWarning(path)}`)
    result = { ...result, principals: undefined }
  }
  if (result.releaseActor) {
    console.error(`⚠ ${globalReleaseActorIgnoredWarning(path)}`)
    result = { ...result, releaseActor: undefined }
  }
  if (result.tokens) {
    console.error(`⚠ ${globalTokensCollectIgnoredWarning(path)}`)
    result = { ...result, tokens: undefined }
  }
  return result
}

/**
 * Resolves the trusted-principal allowlist for this repo: the repo-local
 * `principals` field when set, else `PRINCIPAL_ALLOWLIST` (this monorepo's
 * own hardcoded default — unaffected when no config sets `principals`, the
 * every-existing-install-stays-identical case). Shared by every check bin
 * that verifies a review verdict or a waiver-label actor, so they can never
 * resolve this differently from each other.
 *
 * **Callers MUST pass `loadTrustAnchorConfig()`, never `loadConfig()`, and
 * never any config derived from local git or the working tree.** `principals`
 * names who is trusted to approve a merge; anything the PR being evaluated can
 * reach is something it can rewrite. See `loadTrustAnchorConfig`'s own doc
 * comment for the three failed attempts that established this rule, and for
 * why branch protection — not this function — is the actual boundary.
 */
export function resolvePrincipalAllowlist(config: VinayaConfig | null): string[] {
  return config?.principals ?? PRINCIPAL_ALLOWLIST
}

/**
 * Resolves the expected author of this repo's Changesets release PR: the
 * repo-local `releaseActor` when set, else `DEFAULT_RELEASE_ACTOR` (the
 * stock `changesets/action` identity). Same sourcing rule as
 * `resolvePrincipalAllowlist` — callers MUST pass `loadTrustAnchorConfig()`,
 * never `loadConfig()` or anything env/local-git-derived, since this gates
 * the same class of merge-authority exemption `principals` gates.
 */
export function resolveReleaseActor(config: VinayaConfig | null): string {
  return config?.releaseActor ?? DEFAULT_RELEASE_ACTOR
}

/**
 * ⚠️ **Read this before changing anything about how `principals` is
 * resolved.** Three consecutive attempts at this got it wrong, each fixing
 * the previous one's lever while leaving the same class open (PR #862's own
 * review rounds 1-3):
 *
 *   1. `loadConfig()` — read the PR's own working tree. A PR added its author
 *      to `principals` and self-approved.
 *   2. `git show ${BASE_SHA}:...` — `BASE_SHA` was an env var, and a
 *      `pull_request`-triggered workflow runs the PR's OWN copy of the
 *      workflow YAML, so the PR set `BASE_SHA` to its own head SHA.
 *   3. `git show origin/main:...` with a hardcoded ref — but `origin/main` is
 *      a LOCAL remote-tracking ref inside the job's own disk, and the PR's own
 *      workflow YAML can run `git update-ref refs/remotes/origin/main HEAD`
 *      before this check's step. Reproduced live; the doc comment claiming
 *      "only push access to `main` can move it" conflated that local ref with
 *      the real protected branch on GitHub.
 *
 * The lesson those three share: **inside a `pull_request`-triggered workflow,
 * NOTHING reachable from the job's own filesystem or environment is a trust
 * boundary against the PR author** — the workflow definition itself comes
 * from the PR. So the config CONTENT is read from **GitHub's API**, which
 * serves the repository's default-branch bytes from server-side state the PR
 * cannot touch, rather than from local git or the working tree.
 *
 * **Precisely scoped claim, because the previous two rounds were undone by
 * overclaiming:** the CONTENT is server-side; the repository IDENTITY used to
 * address that API call still comes from `trustAnchorRepo()`, which reads
 * `GITHUB_REPOSITORY` (set by the Actions runner) and falls back to the
 * `origin` remote URL. Both are PR-influenceable in principle. That is
 * deliberate and not a practical lever: where a PR controls the workflow YAML
 * it already holds a strictly stronger primitive (delete the step entirely),
 * and where the YAML is trusted the runner sets `GITHUB_REPOSITORY` correctly
 * so the remote fallback is never reached. The precedence order is therefore
 * load-bearing — runner value first, remote only as a local-dev fallback —
 * and must not be reordered.
 *
 * **This raises the bar; it is not, by itself, the boundary.** A PR can still
 * edit its own copy of the generated workflow to delete this step, `exit 0`,
 * or otherwise not run the gate at all. **GitHub branch protection with this
 * check marked as a required status check** is the necessary next step — it
 * lives in repository settings, outside any PR's reach — but do not write that
 * it makes review enforcement unbypassable, because it does not. A required
 * status check is satisfied by a conclusion reported under its name; it does
 * not certify that the conclusion came from running the real check. Deleting
 * this *step* still leaves the *job* reporting green, and a step edited to
 * `exit 0` reports success having run nothing — only removing the job or the
 * workflow outright produces the never-reports case that blocks the merge.
 * The trust boundary is who controls the workflow definition producing the
 * required check, and under a `pull_request` trigger that is the PR author,
 * whatever the check is packaged as; packaging decides only the blast radius
 * (a repo vendoring this CLI also hands the PR the check sources, the build
 * script, and the dependency lifecycle scripts the install step runs).
 * `vinaya init` prints the branch-protection recommendation and `vinaya
 * doctor` reports when it is missing; an adopter setting `principals` without
 * branch protection has a useful convention, not a security control, and one
 * setting it *with* branch protection has closed merge-without-a-report and
 * nothing further — the reviewer closes the rest. The docs must never imply
 * otherwise in either direction. See `aeg-root/enforcement.md`'s ring-0
 * "Spawning a check" row for the full statement.
 */
export type TrustAnchorFetcher = () => string

/**
 * Repo identity for the trust-anchor read. **Order is load-bearing:** the
 * Actions runner's own `GITHUB_REPOSITORY` first (correct and authoritative
 * in the only context where this is a trust decision), the `origin` remote
 * only as a local-dev fallback. See `loadTrustAnchorConfig`'s doc comment for
 * why neither is a practical attack lever.
 */
export function trustAnchorRepo(): string | null {
  // One shape gate both sources pass through — the remote path used to skip
  // it, and its own `(.+?)` group can capture slashes, so a crafted remote
  // could have produced an `owner/a/b`-shaped value that lands somewhere
  // other than the intended contents endpoint (review finding, PR #862).
  const wellFormed = (slug: string): string | null => (/^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null)

  const fromRunner = process.env.GITHUB_REPOSITORY?.trim()
  if (fromRunner) {
    const validated = wellFormed(fromRunner)
    if (validated) return validated
  }
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/)
    return m?.[1] && m[2] ? wellFormed(`${m[1]}/${m[2]}`) : null
  } catch {
    return null
  }
}

/**
 * Fetches `vinaya.config.json` from the repository's DEFAULT BRANCH via the
 * GitHub API — no `ref` parameter, so GitHub itself picks the default branch
 * from server-side repo settings. The returned CONTENT never comes from local
 * git or the working tree; only the repo identity does (`trustAnchorRepo`).
 */
function ghFetchTrustAnchorConfig(): string {
  const repo = trustAnchorRepo()
  if (!repo) throw new Error('could not resolve repo identity for the trust-anchor read')
  return execFileSync('gh', ['api', `repos/${repo}/contents/${LOCAL_CONFIG_FILENAME}`, '--jq', '.content'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * The trust-anchor config — `vinaya.config.json` as it exists on the
 * repository's default branch per GitHub's own API, never the PR's checkout.
 * The ONLY sanctioned input to `resolvePrincipalAllowlist` in any check.
 *
 * Every failure mode (no repo identity, `gh` unauthenticated or unreachable,
 * file absent on the default branch, malformed JSON, schema mismatch) returns
 * `null`, which `resolvePrincipalAllowlist` turns into the hardcoded
 * `PRINCIPAL_ALLOWLIST` — never into trusting unreviewed content. A local run
 * with no `gh` auth therefore behaves exactly as it did before `principals`
 * existed.
 *
 * That fallback announces itself rather than degrading silently: an adopter
 * whose `principals` failed to resolve would otherwise see their own
 * reviewers' verdicts ignored for no visible reason — precisely the baffling
 * gate failure this field exists to eliminate (review finding, PR #862 round
 * 4). Two deliberate constraints on that message:
 *
 *   - It goes to **stdout, never stderr.** A check bin's stderr IS the
 *     `CheckError` JSON channel (`checks/runner.ts` parses every non-blank
 *     stderr line and marks the check `status: 'error'` on anything that
 *     isn't a valid `CheckError`), so a plain-text warning there would turn
 *     every fetch hiccup into a spurious check failure. `contract.ts` reserves
 *     stdout for exactly this kind of human-readable chatter.
 *   - A **missing file is silent.** A repo whose default branch has no
 *     `vinaya.config.json` yet (a fresh adopter, or the very install PR that
 *     adds it) is an ordinary state, not a fault worth warning about.
 *
 * `fetcher` is injectable for tests ONLY; production callers pass nothing.
 */

/** The first line of an error's message — what the warning quotes, so a multi-line `execFileSync` dump never floods the log. */
function firstLine(err: unknown): string {
  return (err as Error)?.message?.split('\n')[0] ?? 'unknown error'
}

/**
 * Is this failure just "the file isn't on the default branch"?
 *
 * **Must inspect the WHOLE error, not its first line.** `execFileSync` throws
 * with `message = "Command failed: <the entire command>\n<stderr>"`, so `gh`'s
 * actual `Not Found (HTTP 404)` text is never on line 1 — a first-line-only
 * test silently never matched, and every fresh adopter (no config on the
 * default branch yet) got the spurious warning this function exists to
 * suppress. The bug survived four review rounds because the test threw a
 * hand-built single-line `Error('gh: HTTP 404 Not Found')` that no real
 * `execFileSync` ever produces — the test passed while production did the
 * opposite (review finding, PR #862). `stderr` is read directly too, since
 * that is where `gh` actually writes it and it is the more reliable signal.
 */
function isMissingFileError(err: unknown): boolean {
  const stderr = (err as { stderr?: Buffer | string })?.stderr
  const haystack = [
    (err as Error)?.message ?? '',
    typeof stderr === 'string' ? stderr : (stderr?.toString() ?? '')
  ].join('\n')
  return /\b404\b|not found/i.test(haystack)
}

export function loadTrustAnchorConfig(fetcher: TrustAnchorFetcher = ghFetchTrustAnchorConfig): VinayaConfig | null {
  const warn = (why: string) =>
    process.stdout.write(
      `⚠ could not read the trust-anchor config (\`principals\`/\`releaseActor\`) from the default branch (${why}) — falling back to vinaya's built-in defaults.\n`
    )

  let base64: string
  try {
    base64 = fetcher().trim()
  } catch (err) {
    if (!isMissingFileError(err)) warn(firstLine(err))
    return null
  }
  if (!base64) return null
  try {
    const raw = Buffer.from(base64, 'base64').toString('utf-8')
    const parsed = VinayaConfigSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
    warn('it did not satisfy the config schema')
    return null
  } catch {
    warn('it was not readable as JSON')
    return null
  }
}

/**
 * Hierarchical config loader:
 * 1. Repo-local vinaya.config.json (walk up from cwd)
 * 2. Global ~/.vinaya/config.json
 * 3. null if neither exists
 */
export function loadConfig(): VinayaConfig | null {
  const path = configPath()
  if (!path) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return stripGlobalOnlyKeys(VinayaConfigSchema.parse(raw), path)
  } catch {
    return null
  }
}

/**
 * The `ci.setup` command declared by the REPO-ROOT config, or `null`. Used by
 * the generators' callers (`init`/`upgrade`/`doctor`) when building an
 * `InitContext` — deliberately NOT the cwd-walking `loadConfig()`, which
 * would find an ancestor repo's config when a command runs against a nested
 * fixture path (same discipline as init's own `readManifest`). Any read or
 * parse failure is `null`: generation then simply emits no setup step, the
 * same output as an undeclared key.
 */
export function readRepoCiSetup(repoRoot: string): string | null {
  const p = join(repoRoot, 'vinaya.config.json')
  if (!existsSync(p)) return null
  try {
    return VinayaConfigSchema.parse(JSON.parse(readFileSync(p, 'utf-8'))).ci?.setup ?? null
  } catch {
    return null
  }
}

export type ConfigLoadResult = { ok: true; config: VinayaConfig | null } | { ok: false; path: string; error: string }

/**
 * Same hierarchical resolution as `loadConfig()`, but surfaces parse/
 * validation failures instead of swallowing them to `null`. `loadConfig()`
 * itself is UNCHANGED — its existing null-on-failure contract has other
 * callers relying on it, and this task does not alter that signature.
 *
 * Used only by the `check` command path: a typo'd `checks` key silently
 * meaning "no custom checks ran" would make `vinaya check --all` print
 * green over a broken registration — this is the loud alternative.
 */
export function loadConfigChecked(): ConfigLoadResult {
  const path = configPath()
  if (!path) return { ok: true, config: null }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    return { ok: false, path, error: `invalid JSON: ${(err as Error).message}` }
  }

  const parsed = VinayaConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return { ok: false, path, error: detail }
  }
  return { ok: true, config: stripGlobalOnlyKeys(parsed.data, path) }
}

/**
 * Write config to local or global location.
 * - 'local': writes <cwd>/vinaya.config.json
 * - 'global': writes ~/.vinaya/config.json
 */
export function writeConfig(scope: 'local' | 'global', config: VinayaConfig, repoRoot?: string): void {
  let targetPath: string
  if (scope === 'local') {
    const base = repoRoot ?? process.cwd()
    targetPath = join(base, LOCAL_CONFIG_FILENAME)
  } else {
    if (!existsSync(GLOBAL_VINAYA_HOME)) {
      mkdirSync(GLOBAL_VINAYA_HOME, { recursive: true })
    }
    targetPath = GLOBAL_CONFIG_PATH
  }
  writeFileSync(targetPath, JSON.stringify(config, null, 2), 'utf-8')
}

// ---------------------------------------------------------------------------
// tokens.collect trust cache (security review, PR #303, rounds 2-3).
//
// The problem the printed pre-exec warning (round 1) did NOT solve: a
// declared `tokens.collect` command executes IN-PROCESS, unsandboxed,
// automatically, the first time anyone (human or unattended Developer/
// Archivist agent) runs the ordinary `vinaya tokens` command against a repo
// carrying it — with no barrier between "this value exists in a commit" and
// "this value ran". A warning printed synchronously immediately before a
// blocking `execFile` call gives a human no real window to react.
//
// Round 2's fix, direnv-shaped: a declaration must be explicitly TRUSTED
// once, per exact declaration, per machine, before `vinaya tokens` will ever
// execute it — `getTokensCollectTrust` returns nothing (never runs, never
// falls back) until `trustTokensCollectCommand` records it. Approval is a
// real human act (`vinaya tokens --trust-collect`, run once, not part of any
// generated or automated flow) — this file contains no code path that
// self-trusts.
//
// Round 2 shipped with a real gap round 3 closes: trust bound to the
// command STRING alone, never to the CONTENT of the script it invoked —
// approving `"node scripts/collect-usage.js"` once trusted whatever that
// script currently contained, so a LATER commit editing only the script
// (never this config) executed silently on the next run, no re-prompt.
// Live-reproduced by security review. Closed by `tokens.collect`'s own
// grammar narrowing (`parseTokensCollectDeclaration`, above) rather than by
// this cache alone: because a declaration is EXACTLY one interpreter and
// one script path, never an open shell string, there is exactly one file it
// can ever mean — so trust can pin that file's content (`gitBlobHash`) and
// stay rigorous rather than heuristically guessing which token of an
// arbitrary command "looks like a path".
//
// Trust is keyed by (this repo's git common directory, interpreter, script
// path) — NOT by worktree path. This repo's own Developer/Archivist
// dispatch model creates a fresh worktree per task
// (`.worktrees/task/<tranche>/<n>/`), and `git rev-parse --git-common-dir`
// resolves to the ONE shared `.git` directory every worktree of a repo
// points at — approving a declaration once on a machine covers every future
// task worktree of that same repo (the script's bytes are identical there
// too, for the same commit), while a genuinely new interpreter, script
// path, OR script CONTENT always needs its own fresh approval. A repo the
// trust identity cannot be resolved for (`gitCommonDir` returns `null` — no
// git, or `git` itself unavailable) is refused, never silently trusted.
//
// Storage is machine-local (`~/.vinaya/`, the same home `GLOBAL_VINAYA_HOME`
// already uses for the global config) and deliberately NOT the repo-local
// `vinaya.config.json` or anything else a commit can touch — trust is a
// standing fact about what THIS operator has personally approved on THIS
// machine, and a PR can no more grant itself that trust than it can add
// itself to `principals`.
// ---------------------------------------------------------------------------

const TOKENS_COLLECT_TRUST_PATH = join(GLOBAL_VINAYA_HOME, 'tokens-collect-trust.json')

export type TokensCollectTrustEntry = {
  interpreter: string
  script: string
  /** `git hash-object` blob hash of `script`'s bytes at the moment trust was granted. */
  scriptBlobHash: string
  trustedAt: string
}
export type TokensCollectTrustStore = Record<string, TokensCollectTrustEntry>

function readTokensCollectTrustStore(storePath: string): TokensCollectTrustStore {
  try {
    if (!existsSync(storePath)) return {}
    const raw = JSON.parse(readFileSync(storePath, 'utf-8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function writeTokensCollectTrustStore(storePath: string, store: TokensCollectTrustStore): void {
  const dir = dirname(storePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8')
}

/** Plumbing (`git rev-parse`/`git hash-object`) is expected instant; a hang past this is a stuck/hostile `git`, not a slow legitimate answer — never block the caller indefinitely (code review, PR #303, round 2 follow-up: neither exec call site in this file previously bounded its own runtime). */
const GIT_IDENTITY_TIMEOUT_MS = 5_000

/**
 * This repo's git common directory — the ONE directory every worktree of a
 * repo (the primary checkout and every `git worktree add` linked one) shares
 * — canonicalized (`realpathSync`) so two different paths to the same
 * directory (a symlinked home, a relative vs. absolute cwd) hash identically.
 * `null` on any failure (no `git`, not inside a git repository, timeout):
 * callers MUST treat that as "identity unknown", never as license to trust
 * anyway.
 */
export function gitCommonDir(cwd: string = process.cwd()): string | null {
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_IDENTITY_TIMEOUT_MS
    }).trim()
    if (!raw) return null
    return realpathSync(resolve(cwd, raw))
  } catch {
    return null
  }
}

/**
 * The directory holding this repo's own repo-local `vinaya.config.json` —
 * `null` if none resolves (mirrors `findLocalConfig`'s own walk-up-to-the-
 * repo-root bound). `tokens.collect`'s script segment is resolved relative
 * to THIS directory, exactly like `RoleEntrySchema.contract`'s own
 * resolution rule.
 */
export function repoLocalConfigDir(): string | null {
  const local = findLocalConfig()
  return local ? dirname(local) : null
}

/**
 * The `git hash-object` blob hash of a file's CURRENT on-disk bytes —
 * whatever is actually checked out right now, committed or not (so an
 * uncommitted local edit is caught exactly like a committed one). If this
 * content is ever committed unchanged, this is the identical hash that
 * commit's tree entry for this path carries — the trust cache pins the same
 * identifier a `git show`/`git cat-file` investigation would use, not a
 * bespoke one. `null` on any failure (file missing, `git` unavailable,
 * timeout) — never a license to trust anyway.
 */
export function gitBlobHash(absolutePath: string, cwd: string): string | null {
  try {
    const raw = execFileSync('git', ['hash-object', absolutePath], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_IDENTITY_TIMEOUT_MS
    }).trim()
    return raw || null
  } catch {
    return null
  }
}

/**
 * The trust key for one (repo, interpreter, script path) triple — changing
 * any of the three changes the key, so a different repo, interpreter, or
 * script path is always a stranger. Script CONTENT is checked separately
 * (`TokensCollectTrustEntry.scriptBlobHash`, a value the caller compares
 * itself) rather than folded into this key, so "never approved" and
 * "approved, but the script's content has since changed" stay two
 * distinguishable refusals instead of one opaque "not trusted".
 *
 * Hashes `JSON.stringify([...])` — provably injective for any well-formed
 * strings (the surrounding `[`/`,`/`]` structure and per-string escaping can
 * never itself be produced by escaped content), so no two distinct triples
 * can ever collide, regardless of what characters any of the three fields
 * contain.
 */
export function tokensCollectTrustKey(repoGitCommonDir: string, interpreter: string, script: string): string {
  return createHash('sha256')
    .update(JSON.stringify([repoGitCommonDir, interpreter, script]))
    .digest('hex')
}

/**
 * The recorded trust entry for this exact (repo, interpreter, script path)
 * triple, or `null` if it has never been approved on this machine. Callers
 * compare `entry.scriptBlobHash` against the CURRENT content hash
 * themselves (`gitBlobHash`) — this function does not, precisely so "never
 * trusted" and "trusted, but content has since changed" stay distinguishable
 * refusals for the caller to report separately.
 */
export function getTokensCollectTrust(
  repoGitCommonDir: string,
  interpreter: string,
  script: string,
  storePath: string = TOKENS_COLLECT_TRUST_PATH
): TokensCollectTrustEntry | null {
  const key = tokensCollectTrustKey(repoGitCommonDir, interpreter, script)
  return readTokensCollectTrustStore(storePath)[key] ?? null
}

/** Records explicit, one-time approval of this exact (repo, interpreter, script path) triple AT this exact content hash — the only function in this file that grants trust, called from nowhere except the `--trust-collect` CLI path a human types themselves. */
export function trustTokensCollectCommand(
  repoGitCommonDir: string,
  interpreter: string,
  script: string,
  scriptBlobHash: string,
  storePath: string = TOKENS_COLLECT_TRUST_PATH
): void {
  const store = readTokensCollectTrustStore(storePath)
  const key = tokensCollectTrustKey(repoGitCommonDir, interpreter, script)
  store[key] = { interpreter, script, scriptBlobHash, trustedAt: new Date().toISOString() }
  writeTokensCollectTrustStore(storePath, store)
}

export { GLOBAL_VINAYA_HOME, GLOBAL_CONFIG_PATH, LOCAL_CONFIG_FILENAME }
