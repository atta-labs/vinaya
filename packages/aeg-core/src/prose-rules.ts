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
