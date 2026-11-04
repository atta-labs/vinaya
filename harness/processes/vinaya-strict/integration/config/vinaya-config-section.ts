import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  CODE_REVIEW_SEVERITY_ORDER,
  DEFAULT_COLLISION_THRESHOLD,
  DEFAULT_READY_PUSH_TIMEOUT_MINUTES,
  DEFAULT_REVIEW_POLICY,
  type GateCutovers,
  isKnownSeverity,
  NO_GATE_CUTOVERS,
  type ReviewPolicy,
  SECURITY_SEVERITY_ORDER
} from '@attalabs/aeg-core'
import { DEFAULT_RELEASE_ACTOR } from '../../tools/review-gate'
import { normalizeSpecPath } from '../../tools/reader-resolvable-prose'
import {
  fetchFailureReason,
  GIT_IDENTITY_TIMEOUT_MS,
  isMissingFileError,
  NO_TRUST_ANCHOR_REPO_MESSAGE,
  readLocalOverrideFile,
  type TrustAnchorFetcher
} from '../../../../kernel/config/loader/config-loader.js'
import { isSafeRepoRelPath, type KernelConfig } from '../../../../kernel/config/schema/config-schema.js'
import type { GlobalOnlyKey, ProcessConfigSection } from '../../../../kernel/config/schema/process-config-section.js'
import {
  outsideRepositoryReason,
  ProseRulesSchema,
  PublishedProseSchema,
  RepoRelativePathSchema
} from '../../tools/prose-rules-config.js'
import { CLAUDE_COMMAND_PATH } from '../claude-command-emitter.js'
import { GEMINI_COMMAND_PATH } from '../gemini-command-emitter.js'

// Vinaya's section of the configuration: the keys that name its review loop,
// its roles, its briefs and its prose rules — review policy, gate cutovers,
// prose rules, the collision threshold, the release actor, principals, tokens
// collection and the command-emitter paths — with their refinements and
// resolvers. `compose.ts` joins it with the kernel's keys into the one schema.

/** Vinaya's machine-wide home folder and the names of its configuration files. */
export const VINAYA_HOME = join(homedir(), '.vinaya')
export const VINAYA_GLOBAL_CONFIG_FILENAME = 'config.json'
export const VINAYA_CONFIG_FILENAME = 'vinaya.config.json'

// ── The kernel leaves Vinaya supplies ───────────────────────────────────────

// The managed-block path spellings `buildInitOps` ever generates.
// `startsWith('.git/')` (lib/ops.ts's runtime discriminator) is a
// case-sensitive prefix test, and `.git` alone (no trailing slash) resolves
// to a real directory rather than a file — both escape it, one via a
// case-insensitive filesystem, one on every filesystem. Rejecting any spelling
// that isn't byte-exactly one of these prefixes at parse time means
// lib/ops.ts's resolvers never see a bad `blocks[].path`.
//
// `.claude/hooks/` is the fourth: the Claude Code Stop-hook script
// (`claude-stop-hook-emitter.ts`) is a marker-delimited managed block exactly
// like the three git-hook directories, just never `.git/`-prefixed.
export const CANONICAL_HOOK_BLOCK_PREFIXES = ['.git/', '.husky/', '.vinaya/hooks/', '.claude/hooks/'] as const

// Same no-privileged-field discipline as every check field: an adopter's own
// custom check whose failure only their own equivalent of the Principal can
// clear declares this exactly like `test-plan` does in the core registry — see
// `CheckSpec.principalOwed`'s doc comment for the exclusion semantics this
// unlocks. Placed after `ownWorkflow` in every check entry.
export const VINAYA_CHECK_ENTRY_FIELDS = {
  principalOwed: z.literal(true).optional()
}

const AGENTS_SKILLS_PREFIX = '.agents/skills/'
const CLAUDE_SKILLS_PREFIX = '.claude/skills/vinaya-'

/**
 * `true` for the agent-vendor file paths (the two commands and the role
 * skills in both `.agents/skills/` and `.claude/skills/`), but ONLY when the manifest
 * has never recorded any `--agents` choice at all (`agents === undefined`,
 * same condition `resolveAgentVendors` widens to every vendor for).
 * `upgrade`'s `planUpgrade` and `doctor`'s `diagnoseInstall` both gate a
 * `create-file` op on a SEPARATE `manifest.files` ownership list, unrelated
 * to `agents` — without this, `resolveAgentVendors` correctly resolving to
 * every vendor still would not get these files past that second gate,
 * since `manifest.files` never listed them for an install predating the
 * feature. This is the shared other half both callers need.
 */
export function isDefaultedAgentVendorPath(path: string, manifest: { agents?: readonly string[] }): boolean {
  if (manifest.agents !== undefined) return false
  return (
    path === CLAUDE_COMMAND_PATH ||
    path === GEMINI_COMMAND_PATH ||
    path.startsWith(AGENTS_SKILLS_PREFIX) ||
    path.startsWith(CLAUDE_SKILLS_PREFIX)
  )
}

// ── Vinaya's keys ───────────────────────────────────────────────────────────

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

// The upper bound the `report` key's own `superRefine` enforces on
// `report.commandTimeoutMs` — 1 hour. A misconfigured value above this could
// otherwise leave `pr report`'s evidence runner hanging on a stuck
// subprocess for arbitrarily long (a round-2 security ruling).
const MAX_REPORT_COMMAND_TIMEOUT_MS = 3_600_000

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
  // also meant a dropped builtin was permanently invisible. The report
  // makes the divergence visible; this makes a considered choice quiet while
  // an accidental one keeps surfacing.
  ack: z.array(z.enum(BRIEF_BUILTINS)).optional()
})
export type BriefSchema = z.infer<typeof BriefSchemaSchema>

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
 * shell string "looks like a path" (a security-review finding —
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

/** Vinaya's top-level keys, each the schema the composed configuration places under it. */
export const VINAYA_CONFIG_FRAGMENT = {
  roles: z.record(z.string(), RoleEntrySchema).optional(),
  briefSchema: BriefSchemaSchema.optional(),
  // GitHub logins trusted as this repo's own principals for review-gate
  // verdict-author verification and actor-verified waiver labels
  // (`vinaya/waiver:docs`, `vinaya/waiver:review`). There is no built-in
  // default: without it every Principal-deciding check and command refuses
  // (`resolveTrustedPrincipals`). Repo-local only, same as `checks` — stripped from a global config below, since who
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
  // GRAMMAR: exactly
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
  // (`harness/processes/vinaya-strict/tools/task-contract/forge/forge-write.ts`'s `readSharedPackages`, mirroring
  // `packages/aeg-core/bin/open-issue.ts`'s own) is live-derived from
  // `package.json` workspaces plus a built-in cross-cutting default set
  // (lockfile, monorepo config, CI, git hooks); an adopter who needs a
  // domain beyond those (a `migrations/` folder, a codegen output dir)
  // declares it here.
  blastRadius: z.object({ extraDomains: z.array(z.string()).optional() }).optional(),
  // De-hardcodes `reader-resolvable-prose`/`retired-vocabulary`'s repo-specific
  // inputs — the two prose/vocabulary core checks read
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
      legacySlugDir: z.string().min(1).optional(),
      // The source-comment class — scans `.ts` comment lines
      // under these directory roots for a tranche-slug or forge-number
      // citation. Unset entirely (the default) leaves the class dormant, the
      // same "declared no-op, not a silent gap" discipline `readerFacingPrefix`/
      // `readerFacingSuffix` use above. Each entry is a repo-relative
      // directory (or file) path swept recursively for `.ts` files — a
      // prefix, like `PRODUCT_SLUG_SCOPE`, not a shell glob pattern, despite
      // the field's name (chosen to match the brief's own vocabulary for
      // this key).
      sourceComments: z
        .object({
          globs: z.array(z.string().min(1)).optional(),
          // Exact repo-relative file paths to skip entirely — a test fixture
          // that deliberately pins a historical tranche name or forge number
          // in a comment, where rewriting the citation away would break the
          // thing the fixture exists to prove.
          allowlist: z.array(z.string().min(1)).optional(),
          // `'warning'` (the default) reports without failing the run —
          // the rollout precedent every class in this file follows. `'error'`
          // makes a reportable finding fail the check's exit code, same as
          // the `product` class always has.
          severity: z.enum(['warning', 'error']).optional()
        })
        .optional(),
      // Exact repo-relative paths skipped entirely by the spec class below:
      // stock already failing the day this sweep was extended to specs,
      // listed here so the sweep can turn blocking on day one without
      // failing every open PR against the existing backlog. Shrinks as each
      // spec's prose is rewritten to state its facts plainly instead of
      // citing a tranche, an Issue, or a document outside this repository.
      // Exempts a path the defaults below brought in exactly as it exempts
      // one under an app's own `specs/**`.
      //
      // Two forms. An array exempts each listed file entirely. An object maps
      // each listed file to the most spec-class findings it may carry: above
      // its number the file fails, at or below it passes, so a listed file
      // can no longer gain a citation and its number only goes down.
      specGrandfather: z
        .union([z.array(z.string().min(1)), z.record(z.string().min(1), z.number().int().min(0))])
        .optional(),
      // Repo-relative files or folders ADDED to the spec class, on top of
      // the defaults every repository gets with no configuration at all: a
      // root `SPEC.md`, a root `CONTEXT.md`, every `.md` under `docs/adr/`,
      // and every `apps/<app>/specs/**/*.md`. A folder entry is swept
      // recursively for `.md` files; a file entry names that one file.
      // `README.md` is never a default and should not be added lightly — the
      // tranche-slug pattern the class runs matches an ordinary stack badge.
      //
      // An entry names a path inside THIS repository, so one that reaches
      // outside it — absolute, or climbing through `..` — is refused here
      // rather than resolved: the class would otherwise read a file this
      // repository does not own and quote its text in a finding. A trailing
      // slash or a leading `./` is accepted and normalized, since both spell
      // a path this repository does own.
      specPaths: z.array(RepoRelativePathSchema).optional(),
      // The product class's file set — repository-relative files or folders
      // under which a tranche-slug citation in product code blocks. Replaces
      // `PRODUCT_SLUG_SCOPE` (this repository's CLI source, workflows,
      // `.vinaya` and the two package READMEs) when set; never added to it.
      productPaths: z.array(RepoRelativePathSchema).optional(),
      // The published pass (the documentation gate's C7) — see
      // `PublishedProseSchema`.
      published: PublishedProseSchema.optional(),
      // The writing rules both prose checks run: `exempt` (paths no rule
      // reads), `defaults` (per default rule id, `"off"` or a partial
      // override of scopes, severity or exempt) and `custom` (rules a
      // repository writes itself). Validated in full at load, every refusal
      // naming its key — see `prose-rules-config.ts`. Read at check-run time
      // like every key here, so an edit takes effect on the next run.
      rules: ProseRulesSchema.optional()
    })
    .optional(),
  // Config-native project metadata — see the `ProjectEntrySchema` comment
  // above. Additive-only; absent entirely for a single-project repo.
  projects: z.array(ProjectEntrySchema).optional(),
  // `vinaya dispatch <role> --agent <vendor>` (`harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch.ts`).
  // `timeoutMs` is the Developer wall-time ceiling before `dispatchRole`
  // sends `SIGTERM` (then `SIGKILL`) to the child; absent defaults to four
  // hours (`DEFAULT_TIMEOUT_MS` in `dispatch.ts`). `reviewerTimeoutMs` is the
  // corresponding ceiling for code-reviewer and security dispatches; absent
  // defaults to twenty minutes (`DEFAULT_REVIEWER_TIMEOUT_MS`).
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
  // `killGraceMs`: the window between the SIGTERM sent
  // at `timeoutMs` and the SIGKILL escalation that follows it — absent
  // defaults to five seconds (`SIGKILL_GRACE_MS` in `dispatch.ts`). Exists
  // so a test proving the SIGTERM-then-SIGKILL escalation itself happens
  // does not have to pay the real production grace window to observe it: a
  // test config can set this to a few milliseconds and assert the same
  // behavior in a fraction of the wall time, without faking the process
  // signalling it exercises.
  dispatch: z
    .object({
      timeoutMs: z.number().int().positive().optional(),
      reviewerTimeoutMs: z.number().int().positive().optional(),
      killGraceMs: z.number().int().positive().optional(),
      agent: z.enum(['claude', 'codex']).optional()
    })
    .optional(),
  // Which severities block is repository policy — two separate thresholds,
  // one per review role's own ordered
  // severity scale (`@attalabs/aeg-core`'s `CODE_REVIEW_SEVERITY_ORDER`/
  // `SECURITY_SEVERITY_ORDER`). Typed as a bare string here, deliberately NOT
  // `z.enum(...)`: a `z.enum` failure fails the WHOLE config's schema parse,
  // which both `loadConfig`/`loadTrustAnchorConfig` turn into a `null`
  // (each with a one-line warning, but every other field falls back too) —
  // the opposite of this field's own contract. `resolveReviewPolicy`
  // (below) is where an unknown value actually refuses, so a typo here is a
  // review-policy-specific refusal, never a whole-config fallback to
  // defaults. Same trust class as `principals` —
  // read only via `loadTrustAnchorConfig` (the default branch), never the PR
  // checkout, so a change cannot lower its own threshold.
  reviewPolicy: z
    .object({
      codeReviewThreshold: z.string().min(1).optional(),
      securityThreshold: z.string().min(1).optional(),
      // Same deliberately-loose typing as the two thresholds
      // above, for the same reason: a `z.number().int().positive()` failure
      // here would fail the WHOLE config's schema parse (a one-line warning,
      // then every field falls back to defaults) rather than this field's
      // own loud refusal in `resolveReviewPolicy`, below.
      maxRounds: z.number().optional(),
      // Same deliberately-loose typing, same reason as the fields above: a
      // schema-level refusal here would fail the WHOLE config's parse rather
      // than this field's own loud refusal in `resolveReviewPolicy`.
      maxTaskMinutes: z.number().optional(),
      // Same deliberately-loose typing, same reason: the positive-integer
      // refusal lives in `resolveReviewPolicy`.
      readyPushTimeoutMinutes: z.number().optional()
    })
    .optional(),
  // The agent-configuration security scanner the review loop runs before the
  // security pass. `command` is the scanner as an argv
  // list — its first element the executable, the rest its arguments, a pinned
  // version included in the args (`["npx", "--yes", "ecc-agentshield@1.6.0",
  // "scan"]`). The loop appends the directory to scan (the head-verified
  // candidate copy) as a final argument and runs it once per round, ONLY when
  // the pull request touches agent configuration (`.claude/**`, `.mcp.json`,
  // `.agents/**` — fixed in code, never configurable), with a constructed
  // environment carrying no forge credential, a time limit and an output cap.
  // Absent, the security pass is told no scanner is configured and the round
  // proceeds unchanged — never a pause. Read, like `reviewPolicy`/`principals`,
  // only from the default-branch trust anchor (`resolveSecurityScanCommand` +
  // `loadTrustAnchorConfig`), never the pull request's own checkout: the key
  // names a subprocess that runs in the driver's environment, so a pull request
  // must not be able to choose it in its own diff.
  securityScan: z
    .object({
      command: z.array(z.string().min(1)).min(1)
    })
    .optional(),
  // The five Issue/PR gate cutovers — one Issue/PR number per gate below
  // which that gate is grandfathered (an older Issue/PR passes
  // unconditionally). These were hardcoded constants in `@attalabs/aeg-core`
  // (`OBJECTIVES_SINCE_ISSUE` etc.); they are now this optional key so a
  // repository can set its own, and — crucially — an ABSENT key means NO
  // cutover: `resolveGateCutovers` resolves every field to `null`, and each
  // pure gate then applies to every Issue/PR from number 1 (a new repository's
  // Issue 1 is refused without `## Objectives` exactly as a high-numbered
  // Issue is, O1). Only a repository whose Issues/PRs predate a gate sets these
  // — this monorepo does, restating its own historical numbers so its older
  // Issues and pull requests are judged exactly as before (O2). Every field is
  // an optional non-negative integer; an omitted field within the block is
  // itself "no cutover" for that one gate. Read from the working-tree config
  // (`loadConfig`/`loadConfigChecked`), not the trust anchor: the value must be
  // present on THIS branch for the transition to work (the default branch does
  // not carry the key until this merges), and it is the same reviewed-committed
  // trust class the source constants it replaces already had, never a
  // merge-authority decision like `principals`/`reviewPolicy`.
  gateCutovers: z
    .object({
      objectivesSinceIssue: z.number().int().nonnegative().optional(),
      briefSectionsSinceIssue: z.number().int().nonnegative().optional(),
      documentationSinceIssue: z.number().int().nonnegative().optional(),
      briefRulesSincePr: z.number().int().nonnegative().optional(),
      agentBoxesRefusedSincePr: z.number().int().nonnegative().optional()
    })
    .optional(),
  // Plan-time policy. `collisionThreshold` is how many files two open tasks
  // may share before the one being written must declare a `Conflicts-with`
  // edge on the other: at or above it the write is refused, under it the
  // overlap is printed as a warning and both tasks run in parallel. The
  // asymmetry is the whole point — a merge conflict over one or two files
  // costs minutes, serializing a task costs a whole dispatch — so the default
  // (`DEFAULT_COLLISION_THRESHOLD`, three files) is deliberately permissive,
  // and `0` turns the refusal off entirely, leaving only the warning. Read
  // from the working-tree config like `gateCutovers`, and for the same
  // reason: it is adopter policy of the reviewed-committed trust class, never
  // a merge-authority decision like `principals`/`reviewPolicy`.
  planning: z
    .object({
      collisionThreshold: z.number().int().nonnegative().optional()
    })
    .optional(),
  // The pre-push hook's test-file selector (`lib/test-selector.ts`) chooses
  // what to run by import-graph reachability from the diff — a rule whose
  // own INPUT is the repository itself (scans `.github/workflows`, walks
  // `package.json` exec bits, re-derives the changeset/CI-shard manifests)
  // is never reached by that graph; nothing imports it, so it never ran at
  // push time at all. `alwaysRun` names test files (glob, matched
  // against the repo-root-relative path) that run on every push regardless
  // of reachability — additive only, on top of whatever the import graph
  // already selects, never a narrowing of it.
  //
  // `readyTests` opts a self-hosting repository's version-2 ready push, and
  // the driver-owned repair pushes on its own open pull request, into
  // required-CI testing: those pushes keep every cheap local gate and defer
  // the selected test suite to the named required check on the approved
  // head. Read from the default branch only (`pre-push-ready-policy.ts`);
  // absent means local tests. The one supported pair is this repository's
  // own CI workflow and its aggregate check — any other value is refused
  // rather than read as an adopter CI protocol.
  //
  // `requiredCi` names the required current-head check a version-2 run's
  // publication owes whether its selected tests ran locally or were deferred:
  // test execution policy (`readyTests`) never removes it. Read from the
  // default branch only, like `readyTests`; the same one supported pair. An
  // existing `readyTests` opt-in supplies it when this field is absent, and a
  // differing pair in both is refused. Absent with no opt-in, nothing extra is
  // owed.
  prePush: z
    .object({
      alwaysRun: z.array(z.string()).optional(),
      readyTests: z
        .object({
          mode: z.literal('ci'),
          workflow: z.literal('.github/workflows/ci.yml'),
          check: z.literal('Vinaya CI')
        })
        .strict()
        .optional(),
      requiredCi: z
        .object({
          workflow: z.literal('.github/workflows/ci.yml'),
          check: z.literal('Vinaya CI')
        })
        .strict()
        .optional()
    })
    .optional(),
  // The evidence runner's (`vinaya pr report`'s Group C) per-`[agent]`-command
  // subprocess budget — replaces the runner's own prior hardcoded
  // `AGENT_COMMAND_TIMEOUT_MS` constant (30 seconds, far too small for a real
  // Test Plan command — a production build, a booted app, an end-to-end
  // check) with adopter policy. Absent defaults to `900000` (15 minutes,
  // `DEFAULT_COMMAND_TIMEOUT_MS` in `commands/pr-report.ts`). Capped by the
  // `superRefine` below at `3600000` (1 hour) so a misconfigured value cannot
  // leave `pr report` hanging on a stuck subprocess for arbitrarily long
  // (a round-2 security ruling) — checked there, not inline on the
  // field itself, so this field's own type stays exactly what it always was.
  report: z
    .object({
      commandTimeoutMs: z.number().int().positive().optional()
    })
    .superRefine((report, ctx) => {
      const commandTimeoutMs = report.commandTimeoutMs
      if (commandTimeoutMs !== undefined && commandTimeoutMs > MAX_REPORT_COMMAND_TIMEOUT_MS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['commandTimeoutMs'],
          message: 'must be at most 3600000 (1 hour)'
        })
      }
    })
    .optional(),
  // Opt-in decision records. `path` is the folder, relative to the
  // repository root, that holds them: `vinaya new adr <title>` writes the
  // next numbered record there and indexes it, the folder joins the writing
  // rules' `spec` scope, and the `decision-record-citation` rule — which runs
  // only while this key is set — bans citing a record by number anywhere
  // outside the folder. Absent, none of that happens. A path outside the
  // repository, or inside the doctrine tree, is refused by the
  // `superRefine` below, naming this key.
  decisionRecords: z
    .object({
      path: RepoRelativePathSchema
    })
    .strict()
    .optional()
}

/** The parsed value of Vinaya's own keys. */
export type VinayaSectionConfig = z.infer<z.ZodObject<typeof VINAYA_CONFIG_FRAGMENT>>

/**
 * Why `decisionRecords.path` is refused, or `null` when it names a folder
 * inside the repository and outside the doctrine tree. The doctrine tree is
 * `proseGates.doctrineRoot`, or `aeg-root` when that is unset: decision
 * records are the repository's own, never part of the doctrine it ships.
 */
export function decisionRecordsPathIssue(path: string, doctrineRoot: string | undefined): string | null {
  const reason = outsideRepositoryReason(path)
  if (reason) return reason
  const folder = normalizeSpecPath(path)
  if (folder === '' || folder === '.') return 'must name a folder, not the repository root'
  const root = normalizeSpecPath(doctrineRoot ?? 'aeg-root')
  if (folder === root || folder.startsWith(`${root}/`)) {
    return `must be outside the doctrine tree "${root}" — decision records belong to this repository, not to the doctrine it ships`
  }
  return null
}

/**
 * One rule spans two keys and so lives on the section rather than on a field:
 * `decisionRecords.path` may not sit inside the doctrine tree
 * `proseGates.doctrineRoot` names.
 */
function decisionRecordsOutsideDoctrine(config: VinayaSectionConfig, ctx: z.RefinementCtx): void {
  const path = config.decisionRecords?.path
  // A path outside the repository is already refused by the field's own schema.
  if (path === undefined || outsideRepositoryReason(path)) return
  const issue = decisionRecordsPathIssue(path, config.proseGates?.doctrineRoot)
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['decisionRecords', 'path'], message: issue })
}

// ── Keys the machine-wide file may not set ──────────────────────────────────

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

// ── Resolvers ───────────────────────────────────────────────────────────────

/**
 * Resolves the expected author of this repo's Changesets release PR: the
 * repo-local `releaseActor` when set, else `DEFAULT_RELEASE_ACTOR` (the
 * stock `changesets/action` identity). Same sourcing rule as
 * `resolveTrustedPrincipals` — callers MUST pass `loadTrustAnchorConfig()`,
 * never `loadConfig()` or anything env/local-git-derived, since this gates
 * the same class of merge-authority exemption `principals` gates.
 */
export function resolveReleaseActor(config: VinayaSectionConfig | null): string {
  return config?.releaseActor ?? DEFAULT_RELEASE_ACTOR
}

/**
 * Resolves the effective review policy:
 * `config?.reviewPolicy` when set, else `DEFAULT_REVIEW_POLICY`
 * (`BLOCKER`/`HIGH` — today's behaviour, unchanged for a repo that never sets
 * this key). Per-field: an omitted `codeReviewThreshold`/`securityThreshold`
 * defaults; a PRESENT one that is not a real severity on its role's own scale
 * REFUSES (throws), never falls back to the default — an unknown value is a
 * config defect to fix, not a value to silently downgrade past. The two
 * numeric fields (`maxRounds`, `maxTaskMinutes`, `readyPushTimeoutMinutes`)
 * follow the identical rule, each with its own legal range — `maxTaskMinutes`
 * accepts `0`, which turns the task's wall-clock budget off. Same sourcing
 * rule as `resolveTrustedPrincipals`/`resolveReleaseActor`: callers MUST
 * pass `loadTrustAnchorConfig()` (the default branch), never `loadConfig()`
 * or anything PR-checkout-derived, so a change cannot lower its own
 * threshold — the gate and the loop read the identical source.
 */
export function resolveReviewPolicy(config: VinayaSectionConfig | null): ReviewPolicy {
  const raw = config?.reviewPolicy
  if (!raw) return DEFAULT_REVIEW_POLICY

  const codeReviewThreshold = raw.codeReviewThreshold ?? DEFAULT_REVIEW_POLICY.codeReviewThreshold
  if (!isKnownSeverity(CODE_REVIEW_SEVERITY_ORDER, codeReviewThreshold)) {
    throw new Error(
      `vinaya.config.json: reviewPolicy.codeReviewThreshold "${codeReviewThreshold}" is not one of ${CODE_REVIEW_SEVERITY_ORDER.join(' > ')} — fix the config, this never falls back to a default.`
    )
  }
  const securityThreshold = raw.securityThreshold ?? DEFAULT_REVIEW_POLICY.securityThreshold
  if (!isKnownSeverity(SECURITY_SEVERITY_ORDER, securityThreshold)) {
    throw new Error(
      `vinaya.config.json: reviewPolicy.securityThreshold "${securityThreshold}" is not one of ${SECURITY_SEVERITY_ORDER.join(' > ')} — fix the config, this never falls back to a default.`
    )
  }
  // The dev-review-loop's own round
  // cap, replacing `assess-round.ts`'s hardcoded constant. Same refuse-never-
  // downgrade discipline as the two thresholds above: a present-but-invalid
  // value (non-integer, zero, negative) is a config defect to fix.
  const maxRounds = raw.maxRounds ?? DEFAULT_REVIEW_POLICY.maxRounds
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error(
      `vinaya.config.json: reviewPolicy.maxRounds "${maxRounds}" is not a positive integer — fix the config, this never falls back to a default.`
    )
  }
  // The task's own wall-clock budget, in minutes. Same refuse-never-downgrade
  // discipline as the fields above, with one difference the round cap has no
  // equivalent for: `0` is a LEGAL value that turns the budget off, so the
  // floor here is zero rather than one. A negative or fractional value is
  // still a config defect to fix, never a silent fallback.
  const maxTaskMinutes = raw.maxTaskMinutes ?? DEFAULT_REVIEW_POLICY.maxTaskMinutes
  if (!Number.isInteger(maxTaskMinutes) || maxTaskMinutes < 0) {
    throw new Error(
      `vinaya.config.json: reviewPolicy.maxTaskMinutes "${maxTaskMinutes}" is not a non-negative integer (0 turns the budget off) — fix the config, this never falls back to a default.`
    )
  }
  // The version-2 ready push's test-run limit, in minutes. Same refuse-never-
  // downgrade discipline; the floor is one, since a zero-minute limit would
  // stop every run before it started.
  const readyPushTimeoutMinutes = raw.readyPushTimeoutMinutes ?? DEFAULT_READY_PUSH_TIMEOUT_MINUTES
  if (!Number.isInteger(readyPushTimeoutMinutes) || readyPushTimeoutMinutes < 1) {
    throw new Error(
      `vinaya.config.json: reviewPolicy.readyPushTimeoutMinutes "${readyPushTimeoutMinutes}" is not a positive integer — fix the config, this never falls back to a default.`
    )
  }
  return {
    codeReviewThreshold: codeReviewThreshold as ReviewPolicy['codeReviewThreshold'],
    securityThreshold: securityThreshold as ReviewPolicy['securityThreshold'],
    maxRounds,
    maxTaskMinutes,
    readyPushTimeoutMinutes
  }
}

/** The one file name a local run may use to override pacing settings; gitignored, never committed. */
export const LOCAL_OVERRIDE_FILENAME = 'vinaya.config.local.json'

/** The only keys the local file may set. Anything else in it is ignored with a warning. */
export const LOCAL_OVERRIDABLE_KEYS = [
  'reviewPolicy.maxRounds',
  'reviewPolicy.maxTaskMinutes',
  'reviewPolicy.readyPushTimeoutMinutes'
] as const

export type LocalPacingOverride = {
  /** Absolute path of the local file that was read. */
  path: string
  maxRounds?: number
  maxTaskMinutes?: number
  readyPushTimeoutMinutes?: number
  /** Dotted paths present in the file that are outside the allowlist. */
  ignoredKeys: string[]
}

/**
 * The one reader of `vinaya.config.local.json`. Returns the allowlisted pacing
 * values a local run overrides, or `null` when no local file is honoured:
 * a process with `VINAYA_ROLE` set, a CI job (`GITHUB_ACTIONS`), a cwd inside a
 * linked task worktree, a repository with no primary working tree (bare or a
 * separate git dir), a missing file, or a symlinked file. The file is looked up
 * at the primary checkout's root (the dirname of `gitCommonDir`), never by
 * walking up from the cwd. Values are validated with `resolveReviewPolicy`'s
 * own rules and a bad value throws. Keys outside `LOCAL_OVERRIDABLE_KEYS` are
 * ignored with one warning naming them.
 */
export function resolveLocalPacingOverride(cwd: string = process.cwd()): LocalPacingOverride | null {
  const file = readLocalOverrideFile(
    {
      fileName: LOCAL_OVERRIDE_FILENAME,
      overridableKeys: LOCAL_OVERRIDABLE_KEYS,
      suppressedBy: ['VINAYA_ROLE', 'GITHUB_ACTIONS']
    },
    cwd
  )
  if (!file) return null
  const { path, raw, ignoredKeys } = file
  const policy = (
    raw as {
      reviewPolicy?: { maxRounds?: unknown; maxTaskMinutes?: unknown; readyPushTimeoutMinutes?: unknown }
    }
  ).reviewPolicy
  const result: LocalPacingOverride = { path, ignoredKeys }
  if (policy && typeof policy === 'object' && !Array.isArray(policy)) {
    if (policy.maxRounds !== undefined) {
      const v = policy.maxRounds
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
        throw new Error(
          `${LOCAL_OVERRIDE_FILENAME}: reviewPolicy.maxRounds "${String(v)}" is not a positive integer — fix the file, this never falls back to a default.`
        )
      }
      result.maxRounds = v
    }
    if (policy.maxTaskMinutes !== undefined) {
      const v = policy.maxTaskMinutes
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new Error(
          `${LOCAL_OVERRIDE_FILENAME}: reviewPolicy.maxTaskMinutes "${String(v)}" is not a non-negative integer (0 turns the budget off) — fix the file, this never falls back to a default.`
        )
      }
      result.maxTaskMinutes = v
    }
    if (policy.readyPushTimeoutMinutes !== undefined) {
      const v = policy.readyPushTimeoutMinutes
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
        throw new Error(
          `${LOCAL_OVERRIDE_FILENAME}: reviewPolicy.readyPushTimeoutMinutes "${String(v)}" is not a positive integer — fix the file, this never falls back to a default.`
        )
      }
      result.readyPushTimeoutMinutes = v
    }
  }
  return result
}

/**
 * The configured agent-configuration security scanner as an argv list, or
 * `null` when unset. The review loop runs this
 * before dispatching the security pass, on the head-verified candidate copy,
 * appending the directory to scan as a final argument (`decideSecurityScan`).
 *
 * Same sourcing rule as `resolveReviewPolicy`/`resolveTrustedPrincipals`: an
 * unattended caller MUST pass `loadTrustAnchorConfig()` (the default branch),
 * never `loadConfig()` or anything PR-checkout-derived — the command names a
 * subprocess that runs in the driver's own environment, so a pull request must
 * not be able to redirect it in its own diff. Pure: takes the already-loaded
 * config, no I/O of its own.
 */
export function resolveSecurityScanCommand(config: VinayaSectionConfig | null): readonly string[] | null {
  const command = config?.securityScan?.command
  return command && command.length > 0 ? command : null
}

/**
 * Resolves the five gate cutovers: each field of `config?.gateCutovers` when
 * set, else `null`. **An absent key — or an absent field within it — resolves
 * to `null`, which every pure gate reads as NO cutover: the gate applies to
 * every Issue/PR, from number 1 (O1).** This is deliberately the OPPOSITE of
 * `resolveReviewPolicy`'s "absent → the built-in default" — the built-in
 * constants (`OBJECTIVES_SINCE_ISSUE` etc.) are NOT the fallback here; they
 * survive only as each pure validator's own parameter default for a caller
 * that does not resolve config. Every enforcement path calls this and passes
 * the result, so a repository that declares no `gateCutovers` gets no cutover
 * on any gate, while this monorepo restates its historical numbers in its own
 * `vinaya.config.json` and is judged exactly as before (O2).
 *
 * Read from the working-tree config the caller hands in (`loadConfig`/
 * `loadConfigChecked`), never the trust anchor: unlike `principals`/
 * `reviewPolicy` this is not a merge-authority decision, it is the same
 * reviewed-committed trust class the source constants already had, and the
 * value must be present on the CURRENT branch for the migration to hold (the
 * default branch does not carry the key until this change merges).
 */
export function resolveGateCutovers(config: VinayaSectionConfig | null): GateCutovers {
  const raw = config?.gateCutovers
  if (!raw) return NO_GATE_CUTOVERS
  return {
    objectivesSinceIssue: raw.objectivesSinceIssue ?? null,
    briefSectionsSinceIssue: raw.briefSectionsSinceIssue ?? null,
    documentationSinceIssue: raw.documentationSinceIssue ?? null,
    briefRulesSincePr: raw.briefRulesSincePr ?? null,
    agentBoxesRefusedSincePr: raw.agentBoxesRefusedSincePr ?? null
  }
}

/**
 * The resolved `planning.collisionThreshold`: the declared value when set,
 * else `DEFAULT_COLLISION_THRESHOLD`. Unlike `resolveGateCutovers`, an absent
 * key here resolves to the built-in default rather than to "no rule" — a
 * repository that has never heard of this key still wants a collision it
 * cannot merge cheaply to be declared, whereas an absent cutover genuinely
 * means "this repository has no history to grandfather". `0` is a real,
 * honoured value (the refusal off), never conflated with absence.
 */
export function resolveCollisionThreshold(config: VinayaSectionConfig | null): number {
  return config?.planning?.collisionThreshold ?? DEFAULT_COLLISION_THRESHOLD
}

/**
 * ⚠️ **Read this before changing anything about how `principals` is
 * resolved.** Three consecutive attempts at this got it wrong, each fixing
 * the previous one's lever while leaving the same class open (across
 * several review rounds):
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

/**
 * Why `resolveTrustedPrincipals` found no Principal list: `not-configured` —
 * no repository resolves for the read, the default branch has no
 * `vinaya.config.json`, or the file sets no valid `principals` — or
 * `read-failed` — the forge read itself failed (no `gh` authentication, an
 * empty CI token, the network).
 */
export type PrincipalsUnresolvedKind = 'not-configured' | 'read-failed'

/** The one error `resolveTrustedPrincipals` throws; `message` names the fix (`not-configured`) or the reason (`read-failed`). */
export class PrincipalsUnresolvedError extends Error {
  readonly kind: PrincipalsUnresolvedKind

  constructor(kind: PrincipalsUnresolvedKind, message: string) {
    super(message)
    this.name = 'PrincipalsUnresolvedError'
    this.kind = kind
  }
}

/** The fix every `not-configured` refusal names. */
export const PRINCIPALS_FIX = 'add "principals": [...] to vinaya.config.json on the default branch'

function principalsNotConfigured(why: string): PrincipalsUnresolvedError {
  return new PrincipalsUnresolvedError('not-configured', `no Principal is configured (${why}) — ${PRINCIPALS_FIX}.`)
}

/** The trust-anchor reads `resolveTrustedPrincipals` makes, from the composed loader. */
export type TrustedPrincipalsReads = {
  fetch: TrustAnchorFetcher
  parse(content: string, warn: (why: string) => void): { principals?: string[] } | null
}

/**
 * The Principal list, read from `principals` in the default branch's
 * `vinaya.config.json` through the same forge read as `loadTrustAnchorConfig`
 * (see `TrustAnchorFetcher`'s doc comment for why it is never local git, the
 * working tree or an environment variable) — with no built-in fallback. Where
 * no list resolves, this throws `PrincipalsUnresolvedError`, so every check,
 * command and library path that decides who counts as a Principal refuses
 * rather than trusting someone the repository never named.
 *
 * It follows `loadTrustAnchorConfigOrThrow`'s distinction: a missing file
 * (`isMissingFileError`), no resolvable repository, a file with no
 * `principals` and a file that fails the configuration schema are
 * `not-configured`; any other fetch failure is `read-failed`. It never writes
 * a warning itself — a check turns the error into its own `CheckError` line
 * or failure result, a forge-write gate into its refusal, and a command or
 * library lets it propagate.
 *
 * `fetcher` is injectable for tests ONLY; production callers pass nothing.
 */
export function createTrustedPrincipalsResolver(reads: TrustedPrincipalsReads) {
  return function resolveTrustedPrincipals(fetcher: TrustAnchorFetcher = reads.fetch): string[] {
    let content: string
    try {
      content = fetcher()
    } catch (err) {
      if ((err as Error)?.message === NO_TRUST_ANCHOR_REPO_MESSAGE) {
        throw principalsNotConfigured('no repository resolves for the read')
      }
      if (isMissingFileError(err)) throw principalsNotConfigured('the default branch has no vinaya.config.json')
      throw new PrincipalsUnresolvedError(
        'read-failed',
        `could not read "principals" from vinaya.config.json on the default branch: ${fetchFailureReason(err)}`
      )
    }
    const unusable = { why: '' }
    const config = reads.parse(content, (why) => {
      unusable.why = why
    })
    if (config === null) {
      throw principalsNotConfigured(
        `vinaya.config.json on the default branch ${unusable.why ? `is unusable: ${unusable.why}` : 'is empty'}`
      )
    }
    if (!config.principals)
      throw principalsNotConfigured('vinaya.config.json on the default branch sets no "principals"')
    return config.principals
  }
}

/** The line a swallowed trust-anchor read failure prints. */
export function trustAnchorFallbackWarning(why: string): string {
  return `⚠ could not read the trust-anchor config (\`principals\`/\`releaseActor\`) from the default branch (${why}) — falling back to vinaya's built-in defaults.\n`
}

// ---------------------------------------------------------------------------
// tokens.collect trust cache (a security review).
//
// The problem the printed pre-exec warning did NOT solve: a
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
// Storage is machine-local (`~/.vinaya/`, the same home `VINAYA_HOME`
// already uses for the global config) and deliberately NOT the repo-local
// `vinaya.config.json` or anything else a commit can touch — trust is a
// standing fact about what THIS operator has personally approved on THIS
// machine, and a PR can no more grant itself that trust than it can add
// itself to `principals`.
// ---------------------------------------------------------------------------

const TOKENS_COLLECT_TRUST_PATH = join(VINAYA_HOME, 'tokens-collect-trust.json')

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

// ── The section ─────────────────────────────────────────────────────────────

/** Vinaya's keys stripped from the machine-wide file, each placed in the composed order by `compose.ts`. */
export const VINAYA_GLOBAL_ONLY_KEYS = {
  roles: {
    key: 'roles',
    present: (config) => Boolean(config.roles && Object.keys(config.roles).length > 0),
    warning: globalRolesIgnoredWarning
  },
  principals: {
    key: 'principals',
    present: (config) => Boolean(config.principals && config.principals.length > 0),
    warning: globalPrincipalsIgnoredWarning
  },
  releaseActor: {
    key: 'releaseActor',
    present: (config) => Boolean(config.releaseActor),
    warning: globalReleaseActorIgnoredWarning
  },
  tokens: { key: 'tokens', present: (config) => Boolean(config.tokens), warning: globalTokensCollectIgnoredWarning }
} satisfies Record<string, GlobalOnlyKey<VinayaSectionConfig>>

/** Vinaya's process configuration section. */
export const VINAYA_CONFIG_SECTION = {
  keys: Object.keys(VINAYA_CONFIG_FRAGMENT) as (keyof typeof VINAYA_CONFIG_FRAGMENT)[],
  fragment: VINAYA_CONFIG_FRAGMENT,
  refinements: [decisionRecordsOutsideDoctrine],
  globalOnlyKeys: Object.values(VINAYA_GLOBAL_ONLY_KEYS),
  resolvers: {
    resolveReleaseActor,
    resolveReviewPolicy,
    resolveSecurityScanCommand,
    resolveGateCutovers,
    resolveCollisionThreshold,
    resolveLocalPacingOverride,
    decisionRecordsPathIssue,
    isDefaultedAgentVendorPath,
    parseTokensCollectDeclaration
  }
} satisfies ProcessConfigSection<
  typeof VINAYA_CONFIG_FRAGMENT,
  KernelConfig & VinayaSectionConfig,
  Record<string, (...args: never[]) => unknown>
>
