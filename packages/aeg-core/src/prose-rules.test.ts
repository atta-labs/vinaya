import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROSE_RULES } from './prose-rules'

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
    expect(digest()).toBe('e3aeac69a291567a8fae8efcfc8f7bde288e14f6dd188f15c5802eb84c7135e1')
  })
})
