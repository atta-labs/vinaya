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
