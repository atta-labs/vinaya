import { describe, expect, it } from 'vitest'
import { contentAfterTwoLines } from '../src/index'

/**
 * `contentAfterTwoLines` is now the ONE promoted `@attalabs/aeg-core` export
 * (plan-brief-v1 task 3, #428) — `verify-dispatch.ts` imports it from
 * `../src/index` rather than carrying its own copy, the same promoted
 * export `apps/cli`'s `dispatch-task.ts` and `check-brief-shape.ts` import
 * back. These vectors are pinned identically in
 * `apps/cli/tests/lib/dispatch-task.test.ts`, proving both packages agree on
 * the SAME function rather than on two implementations that happen to look
 * alike — the exact "copies disagreeing for months" failure class
 * `edge-resolve.ts`'s own doc comment warns this codebase about.
 */
const CONTENT_AFTER_TWO_LINES_VECTORS: Array<{ name: string; input: string; expected: string }> = [
  {
    name: 'marker, hash line, then brief text with a trailing newline',
    input: '<!-- aeg:brief:v1 -->\nBrief hash: abc123\nThe brief text.\nMore text.\n',
    expected: 'The brief text.\nMore text.\n'
  },
  {
    name: 'marker and hash line only, no body at all',
    input: '<!-- aeg:brief:v1 -->\nBrief hash: abc123',
    expected: ''
  },
  {
    name: 'a body with no newline anywhere',
    input: 'no newline at all',
    expected: ''
  },
  {
    name: 'exactly two lines (no third line to slice out)',
    input: '<!-- aeg:brief:v1 -->\nBrief hash: abc123\n',
    expected: ''
  },
  {
    name: 'a blank line immediately after the hash line survives verbatim',
    input: '<!-- aeg:brief:v1 -->\nBrief hash: abc\n\nBrief text after a blank line.\n',
    expected: '\nBrief text after a blank line.\n'
  },
  {
    name: 'brief text that itself contains a line starting with the marker string',
    input: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nSee <!-- aeg:brief:v1 --> for details.\n',
    expected: 'See <!-- aeg:brief:v1 --> for details.\n'
  }
]

describe('contentAfterTwoLines', () => {
  for (const { name, input, expected } of CONTENT_AFTER_TWO_LINES_VECTORS) {
    it(name, () => {
      expect(contentAfterTwoLines(input)).toBe(expected)
    })
  }
})
