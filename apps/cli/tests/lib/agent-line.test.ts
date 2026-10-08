import { describe, expect, it } from 'bun:test'
import { formatAgentDetails, formatAgentLine, logQuiet } from '../../src/lib/agent-line.js'

describe('formatAgentLine', () => {
  const now = new Date('2026-10-08T03:04:05.678Z')

  it('uses the terminal-friendly role label, local clock, and Unicode mark by default', () => {
    expect(formatAgentLine('code-reviewer', 'reading the brief', { now })).toMatch(
      /^\d{2}:\d{2}:\d{2} {2}▸ Code review {3}reading the brief$/
    )
  })

  it('uses an ISO timestamp and ASCII mark for a non-interactive log line', () => {
    expect(formatAgentLine('developer', 'waiting 10s…', { now, log: true, unicode: false, mark: 'waiting' })).toBe(
      '2026-10-08T03:04:05.678Z  ~ Developer   waiting 10s…'
    )
  })
})

describe('formatAgentDetails', () => {
  it('suppresses details only when quiet mode is enabled', () => {
    expect(logQuiet({ VINAYA_LOG_QUIET: 'true' })).toBe(true)
    expect(formatAgentDetails(['first', '', 'second'], true)).toEqual([])
    expect(formatAgentDetails(['first', '', 'second'], false)).toEqual(['  · first', '  · second'])
  })
})
