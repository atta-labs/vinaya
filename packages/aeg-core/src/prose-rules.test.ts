import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { evaluatePublishedProse, readabilityErrors } from './docs/published-prose'
import {
  CONFIGURABLE_DEFAULT_RULES,
  type CustomProseRule,
  DEFAULT_PROSE_RULES,
  resolveProseRules,
  rulesOfGroup
} from './prose-rules'
import { checkReaderResolvableProse, checkSourceComments, checkUnresolvableReferences } from './reader-resolvable-prose'
import { scanRetiredVocabulary } from './retired-vocabulary'

const EXPECTED_RULES = [
  ['reader-resolvable', 'forge-number', 1],
  ['reader-resolvable', 'tranche-slug', 1],
  ['reader-resolvable', 'task-number', 1],
  ['reader-resolvable', 'source-comment-tranche-slug', 1],
  ['reader-resolvable', 'source-comment-forge-number', 1],
  ['reader-resolvable', 'legacy-batch-name', 0],
  ['reader-resolvable', 'coined-term', 0],
  ...Array.from({ length: 28 }, (_, index) => ['retired-vocabulary', `retired-vocabulary-${index + 1}`, 1]),
  ['published-prose', 'decision-id', 1],
  ['published-prose', 'section-ref', 1],
  ['published-prose', 'forge-number', 1],
  ['published-prose', 'retired-name', 1],
  ['published-prose', 'tranche-slug', 1],
  ['published-prose', 'label-vocabulary', 1],
  ['published-prose', 'internal-path', 1],
  ['published-prose', 'internal-path', 1],
  ['published-prose', 'internal-path', 1]
] as const

describe('default prose rules are complete', () => {
  it('pins every default rule and every per-scope pattern', () => {
    expect(DEFAULT_PROSE_RULES.map((rule) => [rule.group, rule.id, Object.keys(rule.patterns).length])).toEqual(
      EXPECTED_RULES
    )
  })
})

const digest = (): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        DEFAULT_PROSE_RULES.map((rule) => ({
          ...rule,
          patterns: Object.fromEntries(
            Object.entries(rule.patterns).map(([scope, pattern]) => [
              scope,
              pattern instanceof RegExp
                ? {
                    source: pattern.source.replaceAll('\\/', '/').replaceAll('\\u00A7', '§'),
                    flags: pattern.flags
                  }
                : pattern
            ])
          )
        }))
      )
    )
    .digest('hex')

describe('default prose rules content', () => {
  it('pins every pattern text, flag, message, severity and exemption', () => {
    expect(digest()).toBe('81ac72b773c3d3974ac612ffacb2328476af2a87b6ea898fb7f5cfa419c6b07c')
  })
})

const SPEC = { path: 'SPEC.md', content: 'Shipped in #123 by the alpha-v2 batch.\n' }
const PRODUCT = { path: 'apps/cli/src/x.md', content: 'Built during alpha-v2.\n' }
const sweep = (files: { path: string; content: string }[], config?: Parameters<typeof resolveProseRules>[0]) =>
  checkUnresolvableReferences(files, '/none/', '/page.tsx', [], 'aeg-root/', [], undefined, {
    rules: resolveProseRules(config)
  })

describe('configured rule set', () => {
  it('with nothing configured, resolves every default the two checks run, unchanged', () => {
    const set = resolveProseRules()
    expect(set.rules.map((rule) => rule.id).sort()).toEqual(CONFIGURABLE_DEFAULT_RULES.map((rule) => rule.id).sort())
    for (const rule of CONFIGURABLE_DEFAULT_RULES) {
      const resolved = set.rules.find((r) => r.id === rule.id)
      expect(resolved?.scopes).toEqual(rule.scopes)
      if (!rule.scopes.includes('source-comment')) expect(resolved?.severity).toEqual(rule.severity)
    }
    expect(set.exempt).toEqual([])
  })

  it('a default switched off yields no finding', () => {
    expect(sweep([SPEC]).map((f) => f.rule)).toEqual(['forge-number', 'tranche-slug'])
    expect(sweep([SPEC], { defaults: { 'forge-number': 'off' } }).map((f) => f.rule)).toEqual(['tranche-slug'])
  })

  it('a retuned scope and severity take effect', () => {
    expect(sweep([PRODUCT]).map((f) => [f.rule, f.blocking])).toEqual([['tranche-slug', true]])
    expect(sweep([PRODUCT], { defaults: { 'tranche-slug': { scopes: ['spec'] } } })).toEqual([])
    const softened = sweep([SPEC], { defaults: { 'tranche-slug': { severity: 'warning' } } })
    expect(softened.find((f) => f.rule === 'tranche-slug')?.blocking).toBe(false)
    expect(softened.find((f) => f.rule === 'forge-number')?.blocking).toBe(true)
    const moved = sweep([PRODUCT, { path: 'apps/cli/src/y.md', content: 'see #456\n' }], {
      defaults: { 'forge-number': { scopes: ['product'], severity: { product: 'error' } } }
    })
    expect(moved.map((f) => [f.rule, f.blocking, f.message])).toContainEqual([
      'forge-number',
      true,
      `references a forge number in product code ("#456") a reader outside this repo's tracker cannot resolve`
    ])
  })

  it('an exemption — for every rule or for one — stops the rule reading the path', () => {
    expect(sweep([SPEC], { exempt: ['SPEC.md'] })).toEqual([])
    expect(sweep([SPEC], { defaults: { 'forge-number': { exempt: ['./SPEC.md'] } } }).map((f) => f.rule)).toEqual([
      'tranche-slug'
    ])
    const absolute = checkUnresolvableReferences(
      [{ path: '/repo/aeg-root/a.md', content: 'see #123\n' }],
      '/none/',
      '/page.tsx',
      [],
      '/repo/aeg-root/',
      [],
      undefined,
      { rules: resolveProseRules({ exempt: ['aeg-root'] }, { repoRoot: '/repo' }) }
    )
    expect(absolute).toEqual([])
  })

  it('a custom rule prints its own id, the file and line, the matched text and its message', () => {
    const findings = sweep([{ path: 'SPEC.md', content: 'fine\nWe Leverage synergy.\n' }], {
      custom: [{ id: 'acme/no-leverage', pattern: 'leverage', flags: 'i', means: 'say "use"', scopes: ['spec'] }]
    })
    expect(findings).toEqual([
      {
        file: 'SPEC.md',
        line: 2,
        message: 'acme/no-leverage: say "use" ("Leverage")',
        blocking: false,
        rule: 'acme/no-leverage'
      }
    ])
  })

  it('a custom rule takes a per-scope pattern and severity, and an empty match never loops', () => {
    const config = {
      custom: [
        {
          id: 'acme/todo',
          patterns: { spec: 'TODO', ships: 'x*' },
          means: 'unfinished',
          scopes: ['spec', 'ships'],
          severity: { spec: 'error' as const }
        }
      ]
    }
    const findings = sweep(
      [
        { path: 'SPEC.md', content: 'a TODO here\n' },
        { path: 'aeg-root/p.md', content: 'no match here\n' }
      ],
      config
    )
    expect(findings.map((f) => [f.file, f.blocking, f.message])).toEqual([
      ['SPEC.md', true, 'acme/todo: unfinished ("TODO")']
    ])
  })

  it('a custom source-comment rule follows the scope default severity unless it names its own', () => {
    const file = { path: 'src/a.ts', content: '// HACK: later\nconst a = 1\n' }
    const hack: CustomProseRule = {
      id: 'acme/hack',
      pattern: 'HACK',
      means: 'say what is missing',
      scopes: ['source-comment']
    }
    const custom = [hack]
    const scopeDefault = checkSourceComments([file], [], {
      rules: resolveProseRules({ custom }, { sourceCommentSeverity: 'error' })
    })
    expect(scopeDefault.map((f) => [f.rule, f.line, f.blocking])).toEqual([['acme/hack', 1, true]])
    const own = checkSourceComments([file], [], {
      rules: resolveProseRules({ custom: [{ ...hack, severity: 'warning' }] }, { sourceCommentSeverity: 'error' })
    })
    expect(own.map((f) => f.blocking)).toEqual([false])
  })

  it('productPaths replaces the product class file set', () => {
    const file = { path: 'lib/core/a.md', content: 'alpha-v2\n' }
    const run = (productPaths?: readonly string[]) =>
      checkReaderResolvableProse([file], [], '/none/', '/page.tsx', [], 'aeg-root/', [], undefined, { productPaths })
    expect(run()).toEqual([])
    expect(run(['lib/core']).map((f) => f.rule)).toEqual(['tranche-slug'])
  })

  it('the retired group runs custom repository rules and honours a default switched off or softened', () => {
    const files = [{ path: 'aeg-root/a.md', content: 'one\nthe Lock: YES flag\nlegacy widget\n' }]
    expect(scanRetiredVocabulary(files).map((f) => f.rule)).toEqual(['retired-vocabulary-15'])
    const configured = resolveProseRules({
      defaults: { 'retired-vocabulary-15': { severity: 'warning' } },
      custom: [{ id: 'acme/widget', pattern: 'legacy widget', means: 'retired product name', scopes: ['repository'] }]
    })
    expect(scanRetiredVocabulary(files, configured).map((f) => [f.rule, f.line, f.blocking, f.message])).toEqual([
      ['retired-vocabulary-15', 2, false, 'claims a retired AEG mechanism is still live (matches /Lock: ?YES/)'],
      ['acme/widget', 3, true, 'acme/widget: retired product name (matches /legacy widget/)']
    ])
    expect(scanRetiredVocabulary(files, resolveProseRules({ defaults: { 'retired-vocabulary-15': 'off' } }))).toEqual(
      []
    )
  })

  it('each check reads only its own group, so no finding is reported twice', () => {
    const set = resolveProseRules({
      custom: [
        { id: 'acme/a', pattern: 'a', means: 'm', scopes: ['spec'] },
        { id: 'acme/b', pattern: 'b', means: 'm', scopes: ['repository'] }
      ]
    })
    const resolvable = rulesOfGroup(set, 'reader-resolvable').map((rule) => rule.id)
    const retired = rulesOfGroup(set, 'retired-vocabulary').map((rule) => rule.id)
    expect(resolvable).toContain('acme/a')
    expect(retired).toContain('acme/b')
    expect(resolvable.filter((id) => retired.includes(id))).toEqual([])
  })
})

describe('proseGates.published.allow', () => {
  it('defaults to the shipped mechanics and, when configured, replaces them', () => {
    const text = ['Work in `.worktrees/task/<tranche>/<n>` and see apps/cli/x.ts.']
    expect(readabilityErrors('p', text).length).toBe(2)
    expect(readabilityErrors('p', text, ['apps/cli/x.ts', '.worktrees/task/<tranche>/<n>'])).toEqual([])
    // A configured list replaces the shipped one rather than adding to it.
    expect(readabilityErrors('p', text, ['apps/cli/x.ts']).length).toBe(0)
    expect(readabilityErrors('p', ['see apps/cli/x.ts'], ['.worktrees/']).length).toBe(2)
    expect(evaluatePublishedProse([], new Set(), []).errors).toEqual([])
  })
})

describe('decision-record-citation', () => {
  const files = [
    { path: 'aeg-root/roles/x.md', content: 'As ADR-7 decided, the loop retries.\n' },
    { path: 'SPEC.md', content: 'Intro.\nSee [the record](records/0003-retire-locks.md).\n' },
    { path: 'records/0004-new.md', content: 'Supersedes ADR 3 and records/0003-retire-locks.md.\n' },
    { path: 'apps/cli/src/x.ts', content: '// keeps ADR-12 alive\nexport const x = 1\n' }
  ]
  const specPaths = ['SPEC.md', 'records']
  const sweep = (set = resolveProseRules()) =>
    checkUnresolvableReferences(files, '/none/', '/none.tsx', [], 'aeg-root/', [], specPaths, {
      rules: set,
      productPaths: ['apps/cli/src']
    }).filter((f) => f.rule === 'decision-record-citation')

  it('is absent with no decision-record folder configured', () => {
    expect(resolveProseRules().rules.map((rule) => rule.id)).not.toContain('decision-record-citation')
    expect(sweep()).toEqual([])
    expect(checkSourceComments(files).filter((f) => f.rule === 'decision-record-citation')).toEqual([])
    const page = [{ relPath: 'enforcement.md', frontmatter: { surfaced: true }, body: 'Per ADR-2.' }]
    expect(evaluatePublishedProse(page, new Set(['enforcement.md'])).errors.join('\n')).not.toContain(
      'decision-record number'
    )
  })

  it('blocks a numbered citation in the doctrine, specs and product code, but never inside the folder', () => {
    const set = resolveProseRules(undefined, { decisionRecordsPath: './records/' })
    expect(sweep(set).map((f) => [f.file, f.line, f.blocking])).toEqual([
      ['aeg-root/roles/x.md', 1, true],
      ['SPEC.md', 2, true],
      ['apps/cli/src/x.ts', 1, true]
    ])
    const comments = checkSourceComments(files, [], { rules: set }).filter((f) => f.rule === 'decision-record-citation')
    expect(comments.map((f) => [f.file, f.blocking])).toEqual([['apps/cli/src/x.ts', true]])
  })

  it('runs in the published pass only while the folder is configured', () => {
    expect(readabilityErrors('p', ['Per ADR 2, we ship.'], [], { decisionRecordsPath: 'records' })).toEqual([
      'C7: published text in "p" contains a decision-record number a reader cannot resolve: "ADR 2"'
    ])
    expect(readabilityErrors('p', ['Per ADR 2, we ship.'], [])).toEqual([])
  })

  it('reads plain words and unnumbered files as prose, not citations', () => {
    const set = resolveProseRules(undefined, { decisionRecordsPath: 'records' })
    const plain = [{ path: 'SPEC.md', content: 'We keep ADRs in records/README.md; see ADRS.\n' }]
    expect(
      checkUnresolvableReferences(plain, '/none/', '/none.tsx', [], 'aeg-root/', [], specPaths, { rules: set }).filter(
        (f) => f.rule === 'decision-record-citation'
      )
    ).toEqual([])
  })
})
