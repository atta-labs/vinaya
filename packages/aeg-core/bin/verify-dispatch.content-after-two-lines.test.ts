import { describe, expect, it } from 'vitest'
import { contentAfterTwoLines } from './verify-dispatch'

/**
 * Pinned identically in
 * `apps/cli/tests/lib/dispatch-task.test.ts`'s own `contentAfterTwoLines`
 * suite, against `dispatch-task.ts`'s copy of this same function —
 * `verify-dispatch.ts` lives in a genuinely separate package and cannot
 * import `apps/cli` at all, so this file keeps its own implementation
 * rather than sharing one. Found live (code review): a hash-contract-
 * critical slice duplicated with zero test proving the two copies agree is
 * exactly the "three copies disagreeing for months" failure class
 * `edge-resolve.ts`'s own doc comment already warns this codebase about.
 * These identical fixture vectors are what make a future drift between the
 * two copies fail a test on whichever side changed, instead of surviving
 * as an undetected mismatch.
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
