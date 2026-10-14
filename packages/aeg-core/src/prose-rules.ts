export type ProseRuleSeverity = 'error' | 'warning'

export type DefaultProseRule = {
  id: string
  group: 'reader-resolvable' | 'retired-vocabulary' | 'published-prose'
  scopes: readonly string[]
  patterns: Readonly<Record<string, RegExp | string>>
  flags: readonly string[]
  message: string
  severity: Readonly<Record<string, ProseRuleSeverity>>
  exemptions: readonly string[]
  patternExemptions?: Readonly<Record<string, readonly string[]>>
  builtIn?: boolean
}

export const RETIRED_GLOBAL_EXEMPTIONS = [
  'docs/decisions-legacy.md',
  'apps/herald-ai/docs/',
  'apps/vada-ai/docs/',
  'aeg-root/tranches/completed/',
  'packages/aeg-core/src/docs/published-prose',
  'packages/aeg-core/src/retired-vocabulary.test.ts',
  'packages/aeg-core/src/retired-vocabulary.ts',
  '/fixtures/',
  '/node_modules/',
  '/.next/',
  '/.turbo/'
] as const

export const PLAN_ON_DISK_PATTERNS: readonly string[] = ['[Tt]opology files?', 'aeg-root/tranches/', 'aeg-project/']

export const TRANCHE_MODEL_FILE = '/tranche-model.md'

export const RETIRED_PATTERN_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {
  [String.raw`\bD-[0-9]{3}\b`]: ['./CLAUDE.md'],
  [String.raw`decisions\.md`]: [
    'docs-index.md',
    'apps/vada-ai/specs/legacy/README.md',
    'apps/vada-ai/specs/vada-product-spec.md',
    'apps/vada-ai/web/CLAUDE.md',
    'apps/vada-ai/CLAUDE.md'
  ],
  'decisions-legacy': [
    'packages/aeg-core/src/file-classify.ts',
    'packages/aeg-core/src/file-classify.test.ts',
    'packages/aeg-core/src/pr-tier.test.ts',
    'docs-index.md',
    '.claude/skills/database/SKILL.md',
    '.claude/skills/vada-architecture/SKILL.md',
    'apps/vada-ai/specs/vada-byok-principles.md',
    'apps/vada-ai/web/CLAUDE.md',
    'apps/vada-ai/CLAUDE.md'
  ],
  CONTRADICTION: ['apps/vada-ai/specs/vada-reviewers-spec.md'],
  ...Object.fromEntries(PLAN_ON_DISK_PATTERNS.map((pattern) => [pattern, [TRANCHE_MODEL_FILE]]))
}

const retiredPatterns = [
  String.raw`\bD-[0-9]{3}\b`,
  'D-(###|NNN|nnn|xxx)',
  'decision (entry|logged)',
  'decision-log entry',
  'decision log entry',
  'decision log(s|ged|ging)?([^a-z]|$)',
  'decision-log',
  'decision entr',
  'decisions? (are |is )?logged',
  'log entries',
  String.raw`decisions\.md`,
  'decisions-legacy',
  'CONTRADICTION',
  'assumes Tier 3',
  'Lock: ?YES',
  'Lock: ?NO',
  'lock approvals?',
  'approves locks',
  'Conforms to lock',
  'Challenges lock',
  'checkDecisionNumbersFresh',
  String.raw`roles/team-leader\.md`,
  String.raw`\(,`,
  String.raw`,\)`,
  String.raw`\(\.\)`,
  ...PLAN_ON_DISK_PATTERNS
] as const

const published = [
  ['decision-id', 'a decision id', /\bD-\d{3,}\b/],
  ['section-ref', 'a section reference', /§/],
  ['forge-number', 'a forge number', /#\d+/],
  ['retired-name', 'the retired public name', /\bAEG\b/],
  ['tranche-slug', 'a tranche slug', /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+-v\d+\b/],
  [
    'label-vocabulary',
    'forge label vocabulary',
    /(?:vinaya\/)?\b(?:tranche|iteration|tier|needs|waiver|project|aeg):(?![/\s]|$)/
  ],
  ['internal-path', 'a repo-internal path', /\b(?:packages|apps|aeg-root|tools|scripts)\//],
  ['internal-path', 'a repo-internal path', /\.(?:claude|husky|github)\//],
  [
    'internal-path',
    'a repo-internal file',
    /(?:^|[\s(`"'[])[\w.-]+(?:\/[\w.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|sh|ya?ml|json|md)\b/
  ]
] as const

export const DEFAULT_PROSE_RULES: readonly DefaultProseRule[] = [
  {
    id: 'forge-number',
    group: 'reader-resolvable',
    scopes: ['ships', 'reader-facing', 'spec'],
    patterns: { prose: /#[0-9]{2,4}/g },
    flags: ['global'],
    message: 'a forge number',
    severity: { ships: 'warning', 'reader-facing': 'warning', spec: 'error' },
    exemptions: []
  },
  {
    id: 'tranche-slug',
    group: 'reader-resolvable',
    scopes: ['ships', 'reader-facing', 'product', 'spec'],
    patterns: { prose: /[a-z][a-z-]+-v[0-9]/g },
    flags: ['global'],
    message: 'an internal tranche slug',
    severity: { ships: 'warning', 'reader-facing': 'warning', product: 'error', spec: 'error' },
    exemptions: []
  },
  {
    id: 'task-number',
    group: 'reader-resolvable',
    scopes: ['spec'],
    patterns: { prose: /(^|[^a-z0-9-])(tasks?[ \t]+#?[0-9]+)/gi },
    flags: ['global', 'ignore-case'],
    message: 'a task number',
    severity: { spec: 'error' },
    exemptions: []
  },
  {
    id: 'source-comment-tranche-slug',
    group: 'reader-resolvable',
    scopes: ['source-comment'],
    patterns: { comment: /[a-z0-9]+(?:-[a-z0-9]+)*-v[0-9]+/g },
    flags: ['global'],
    message: 'a tranche-slug citation',
    severity: { 'source-comment': 'warning' },
    exemptions: []
  },
  {
    id: 'source-comment-forge-number',
    group: 'reader-resolvable',
    scopes: ['source-comment'],
    patterns: { comment: /#[0-9]{2,}/g },
    flags: ['global'],
    message: 'a forge-number citation',
    severity: { 'source-comment': 'warning' },
    exemptions: []
  },
  {
    id: 'legacy-batch-name',
    group: 'reader-resolvable',
    scopes: ['ships', 'reader-facing', 'spec'],
    patterns: {},
    flags: ['built-in'],
    message: 'an internal tranche slug',
    severity: { ships: 'warning', 'reader-facing': 'warning', spec: 'error' },
    exemptions: [],
    builtIn: true
  },
  {
    id: 'coined-term',
    group: 'reader-resolvable',
    scopes: ['ships', 'reader-facing'],
    patterns: {},
    flags: ['built-in'],
    message: 'uses coined term without defining it inline or linking the glossary',
    severity: { ships: 'warning', 'reader-facing': 'warning' },
    exemptions: [],
    builtIn: true
  },
  ...retiredPatterns.map((pattern, index) => ({
    id: `retired-vocabulary-${index + 1}`,
    group: 'retired-vocabulary' as const,
    scopes: ['repository'],
    patterns: { repository: pattern },
    flags: [],
    message: 'retired vocabulary',
    severity: { repository: 'error' as const },
    exemptions: RETIRED_GLOBAL_EXEMPTIONS,
    patternExemptions: RETIRED_PATTERN_EXEMPTIONS
  })),
  ...published.map(([id, message, pattern]) => ({
    id,
    group: 'published-prose' as const,
    scopes: ['published'],
    patterns: { published: pattern },
    flags: [],
    message,
    severity: { published: 'error' as const },
    exemptions: ['.worktrees/task/<tranche>/<n>', 'task/<tranche>/<n>', '.worktrees/']
  }))
]

export const rulesForGroup = (group: DefaultProseRule['group']): readonly DefaultProseRule[] =>
  DEFAULT_PROSE_RULES.filter((rule) => rule.group === group)

export const proseSeverity = (id: string, scope: string): ProseRuleSeverity | undefined =>
  DEFAULT_PROSE_RULES.find((rule) => rule.id === id)?.severity[scope]

/**
 * The scopes a repository's own configuration may name, and the check that
 * reads each one. `reader-resolvable-prose` runs every rule whose scopes fall
 * in the first set; `retired-vocabulary` runs every rule whose scopes fall in
 * the second. `published` is absent on purpose: the published pass belongs
 * to the documentation gate, and `proseGates.published.allow` is its only
 * setting.
 */
export const RESOLVABLE_SCOPES = ['ships', 'reader-facing', 'product', 'spec', 'source-comment'] as const
export const RETIRED_SCOPES = ['repository'] as const
export const CONFIGURABLE_PROSE_SCOPES: readonly string[] = [...RESOLVABLE_SCOPES, ...RETIRED_SCOPES]

/** The two rule groups a configured rule can join — one per prose check. */
export type ProseCheckGroup = 'reader-resolvable' | 'retired-vocabulary'

/** The group whose check reads `scope`, or `undefined` for a scope no configured rule may name. */
export function groupOfScope(scope: string): ProseCheckGroup | undefined {
  if ((RESOLVABLE_SCOPES as readonly string[]).includes(scope)) return 'reader-resolvable'
  if ((RETIRED_SCOPES as readonly string[]).includes(scope)) return 'retired-vocabulary'
  return undefined
}

/** The regular-expression flags a configured rule may carry. */
export const CONFIGURED_PROSE_FLAGS: readonly string[] = ['i', 'u']

/** The longest pattern a repository may configure. The shipped defaults are not held to it. */
export const CONFIGURED_PATTERN_MAX_LENGTH = 200

/** The defaults `proseGates.rules.defaults` may address: every rule one of the two prose checks runs. */
export const CONFIGURABLE_DEFAULT_RULES: readonly DefaultProseRule[] = DEFAULT_PROSE_RULES.filter(
  (rule): rule is DefaultProseRule & { group: ProseCheckGroup } => rule.group !== 'published-prose'
)

/**
 * The scopes a default rule may be moved to. A built-in rule computes its
 * own matches for the scopes it ships with, so it may only narrow them; a
 * pattern rule may take any scope its own check reads.
 */
export function allowedScopesFor(rule: DefaultProseRule): readonly string[] {
  if (rule.builtIn) return rule.scopes
  return rule.group === 'retired-vocabulary' ? RETIRED_SCOPES : RESOLVABLE_SCOPES
}

export type ProseRuleSeveritySetting = ProseRuleSeverity | Readonly<Record<string, ProseRuleSeverity>>

/** `proseGates.rules.defaults.<id>` — switch a default off, or retune its scopes, severity or exemptions. Its pattern and message are never configurable. */
export type ProseRuleOverride =
  | 'off'
  | {
      scopes?: readonly string[]
      severity?: ProseRuleSeveritySetting
      exempt?: readonly string[]
    }

/** `proseGates.rules.custom[]` — a rule a repository writes for itself. */
export type CustomProseRule = {
  id: string
  pattern?: string
  patterns?: Readonly<Record<string, string>>
  flags?: string
  means: string
  scopes: readonly string[]
  severity?: ProseRuleSeveritySetting
  exempt?: readonly string[]
}

/** `proseGates.rules`. */
export type ProseRulesConfig = {
  exempt?: readonly string[]
  defaults?: Readonly<Record<string, ProseRuleOverride>>
  custom?: readonly CustomProseRule[]
}

/** One rule as a check runs it: a default with its configuration applied, or a custom rule. */
export type ResolvedProseRule = {
  id: string
  group: ProseCheckGroup
  custom: boolean
  builtIn: boolean
  scopes: readonly string[]
  /** The default's message, or the custom rule's `means`. */
  message: string
  severity: Readonly<Record<string, ProseRuleSeverity>>
  /** Configured path exemptions: repository-relative files or folders this rule does not read. */
  exempt: readonly string[]
  /** The default's own substring exemptions (the retired group's archives and history), unchanged. */
  substringExempt: readonly string[]
  /** The capture holding the cited text, when the pattern carries boundary characters around it. */
  reportGroup?: number
  /** The pattern for one scope, or `null` when the rule has none there. */
  patternFor: (scope: string) => RegExp | null
}

export type ProseRuleSet = {
  rules: readonly ResolvedProseRule[]
  /** `proseGates.rules.exempt` — paths no rule reads. */
  exempt: readonly string[]
  /** Absolute repository root, stripped from an absolute file path before an exemption is compared. */
  repoRoot?: string
}

/** One repository path in a single spelling: forward slashes, no leading `./`, no doubled or trailing slash. */
export function normalizeRepoPath(entry: string): string {
  let out = entry.replace(/\\/g, '/')
  while (out.startsWith('./')) out = out.slice(2)
  out = out.replace(/\/{2,}/g, '/')
  while (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** Whether a configured exemption list covers `path` — the path itself, or anything under a listed folder. */
export function isConfiguredExempt(path: string, exempt: readonly string[], repoRoot?: string): boolean {
  if (exempt.length === 0) return false
  const root = repoRoot === undefined ? undefined : normalizeRepoPath(repoRoot)
  let rel = normalizeRepoPath(path)
  if (root && rel.startsWith(`${root}/`)) rel = rel.slice(root.length + 1)
  return exempt.some((entry) => {
    const e = normalizeRepoPath(entry)
    return rel === e || rel.startsWith(`${e}/`)
  })
}

/** Whether `rule` reads `path` at all under `set`'s exemptions. */
export function ruleReads(set: ProseRuleSet, rule: ResolvedProseRule, path: string): boolean {
  return !isConfiguredExempt(path, set.exempt, set.repoRoot) && !isConfiguredExempt(path, rule.exempt, set.repoRoot)
}

/** The order the reader-resolvable rules have always run in, so an unconfigured run reports findings in the same order. */
const RESOLVABLE_RUN_ORDER = [
  'forge-number',
  'tranche-slug',
  'legacy-batch-name',
  'task-number',
  'source-comment-tranche-slug',
  'source-comment-forge-number',
  'coined-term'
]

const REPORT_GROUPS: Readonly<Record<string, number>> = { 'task-number': 2, 'legacy-batch-name': 2 }

/** A scope's severity when nothing names one: the source-comment scope follows `proseGates.sourceComments.severity`, the retired check blocks, every other scope warns. */
function scopeDefaultSeverity(scope: string, sourceCommentSeverity: ProseRuleSeverity | undefined): ProseRuleSeverity {
  if (scope === 'source-comment') return sourceCommentSeverity ?? 'warning'
  if (scope === 'repository') return 'error'
  return 'warning'
}

function applySeverity(
  scopes: readonly string[],
  base: Readonly<Record<string, ProseRuleSeverity>>,
  setting: ProseRuleSeveritySetting | undefined
): Record<string, ProseRuleSeverity> {
  const out: Record<string, ProseRuleSeverity> = {}
  for (const scope of scopes) {
    const configured = typeof setting === 'string' ? setting : setting?.[scope]
    const value = configured ?? base[scope]
    if (value !== undefined) out[scope] = value
  }
  return out
}

function defaultPatternFor(rule: DefaultProseRule): (scope: string) => RegExp | null {
  const cache = new Map<string, RegExp | null>()
  return (scope) => {
    if (cache.has(scope)) return cache.get(scope) ?? null
    const own =
      rule.patterns[scope] ??
      (scope === 'source-comment' ? rule.patterns.comment : rule.patterns.prose) ??
      Object.values(rule.patterns)[0]
    const compiled = own === undefined ? null : own instanceof RegExp ? own : new RegExp(own)
    cache.set(scope, compiled)
    return compiled
  }
}

function customPatternFor(rule: CustomProseRule, global: boolean): (scope: string) => RegExp | null {
  const cache = new Map<string, RegExp | null>()
  return (scope) => {
    if (cache.has(scope)) return cache.get(scope) ?? null
    const source = rule.patterns?.[scope] ?? rule.pattern
    const compiled = source === undefined ? null : new RegExp(source, `${rule.flags ?? ''}${global ? 'g' : ''}`)
    cache.set(scope, compiled)
    return compiled
  }
}

/**
 * The rule set the two prose checks run: every default the two checks own,
 * with `config.defaults` applied (an `"off"` default is dropped), followed by
 * `config.custom` in the order written. With no configuration this is the
 * defaults exactly as shipped, so an unconfigured run reports what it always
 * did. `options.decisionRecordsPath` — `decisionRecords.path` — adds the
 * decision-record citation rule after the custom rules; absent, the rule is
 * not in the set at all. Validation is the configuration loader's job; this
 * function trusts its input.
 */
export function resolveProseRules(
  config: ProseRulesConfig | undefined = undefined,
  options: { sourceCommentSeverity?: ProseRuleSeverity; repoRoot?: string; decisionRecordsPath?: string } = {}
): ProseRuleSet {
  const rules: ResolvedProseRule[] = []
  const defaults = config?.defaults ?? {}
  for (const rule of CONFIGURABLE_DEFAULT_RULES) {
    const override = defaults[rule.id]
    if (override === 'off') continue
    const group = rule.group as ProseCheckGroup
    const scopes = override?.scopes ?? rule.scopes
    const base: Record<string, ProseRuleSeverity> = {}
    for (const scope of scopes) {
      base[scope] =
        scope === 'source-comment'
          ? (options.sourceCommentSeverity ?? rule.severity[scope] ?? 'warning')
          : (rule.severity[scope] ?? scopeDefaultSeverity(scope, options.sourceCommentSeverity))
    }
    rules.push({
      id: rule.id,
      group,
      custom: false,
      builtIn: rule.builtIn === true,
      scopes,
      message: rule.message,
      severity: applySeverity(scopes, base, override?.severity),
      exempt: override?.exempt ?? [],
      substringExempt: rule.exemptions,
      reportGroup: REPORT_GROUPS[rule.id],
      patternFor: defaultPatternFor(rule)
    })
  }
  for (const rule of config?.custom ?? []) {
    const group = groupOfScope(rule.scopes[0] ?? '') ?? 'reader-resolvable'
    const base: Record<string, ProseRuleSeverity> = {}
    for (const scope of rule.scopes) base[scope] = scopeDefaultSeverity(scope, options.sourceCommentSeverity)
    rules.push({
      id: rule.id,
      group,
      custom: true,
      builtIn: false,
      scopes: rule.scopes,
      message: rule.means,
      severity: applySeverity(rule.scopes, base, rule.severity),
      exempt: rule.exempt ?? [],
      substringExempt: [],
      patternFor: customPatternFor(rule, group === 'reader-resolvable')
    })
  }
  if (options.decisionRecordsPath !== undefined) rules.push(decisionRecordCitationRule(options.decisionRecordsPath))
  const order = (rule: ResolvedProseRule): number => {
    const at = RESOLVABLE_RUN_ORDER.indexOf(rule.id)
    return rule.custom || at === -1 ? RESOLVABLE_RUN_ORDER.length : at
  }
  const resolvable = rules.filter((rule) => rule.group === 'reader-resolvable')
  const sorted = resolvable
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => order(a.rule) - order(b.rule) || a.index - b.index)
    .map(({ rule }) => rule)
  return {
    rules: [...sorted, ...rules.filter((rule) => rule.group === 'retired-vocabulary')],
    exempt: config?.exempt ?? [],
    repoRoot: options.repoRoot
  }
}

/** The rules one check runs, in run order. */
export function rulesOfGroup(set: ProseRuleSet, group: ProseCheckGroup): readonly ResolvedProseRule[] {
  return set.rules.filter((rule) => rule.group === group)
}

/** The rules one check runs in one scope, in run order. */
export function rulesInScope(set: ProseRuleSet, scope: string): readonly ResolvedProseRule[] {
  return set.rules.filter((rule) => rule.scopes.includes(scope))
}

/** The rule set with nothing configured — what both checks run by default. */
export const DEFAULT_PROSE_RULE_SET: ProseRuleSet = resolveProseRules()

/** The id of the rule `decisionRecords.path` switches on. */
export const DECISION_RECORD_CITATION_ID = 'decision-record-citation'

/** Where the decision-record citation rule reads: the doctrine pages, the specs, product code and source comments — and the published pass, which runs it separately. */
export const DECISION_RECORD_CITATION_SCOPES: readonly string[] = ['ships', 'product', 'spec', 'source-comment']

/** The message a decision-record citation finding prints. */
export const DECISION_RECORD_CITATION_MESSAGE = 'a decision-record number'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The decision-record citation pattern for the folder `decisionRecordsPath`:
 * `ADR` followed by a number (`ADR-7`, `ADR 0007`, `ADR7`), or a path to a
 * numbered file in that folder (`docs/adr/0007-retire-locks.md`). A record's
 * number means nothing to a reader without the folder in front of them, so
 * text outside the folder states the decision instead of citing it.
 */
export function decisionRecordCitationPattern(decisionRecordsPath: string): RegExp {
  const folder = escapeRegExp(normalizeRepoPath(decisionRecordsPath))
  return new RegExp(String.raw`\bADR[- ]?[0-9]+\b|(?<![A-Za-z0-9_-])${folder}/[0-9]+[A-Za-z0-9._-]*`, 'g')
}

/**
 * The decision-record citation rule, resolved for one folder. It exists only
 * while `decisionRecords.path` is set — `resolveProseRules` adds it when its
 * `decisionRecordsPath` option is given and never otherwise — and it never
 * reads the folder itself, so a record may name the record it supersedes.
 */
export function decisionRecordCitationRule(decisionRecordsPath: string): ResolvedProseRule {
  const folder = normalizeRepoPath(decisionRecordsPath)
  const pattern = decisionRecordCitationPattern(folder)
  const severity: Record<string, ProseRuleSeverity> = {}
  for (const scope of DECISION_RECORD_CITATION_SCOPES) severity[scope] = 'error'
  return {
    id: DECISION_RECORD_CITATION_ID,
    group: 'reader-resolvable',
    custom: false,
    builtIn: false,
    scopes: DECISION_RECORD_CITATION_SCOPES,
    message: DECISION_RECORD_CITATION_MESSAGE,
    severity,
    exempt: [folder],
    substringExempt: [],
    patternFor: () => pattern
  }
}
