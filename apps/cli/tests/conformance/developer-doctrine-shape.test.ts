import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  countWords,
  extractShortVersion,
  ROLE_BLOCKS,
  SHORT_VERSION_MAX_WORDS,
  SHORT_VERSION_MIN_WORDS
} from '@attalabs/aeg-core/docs'
import { resolveDoctrineRoot } from '../../src/commands/doctrine'
import {
  assembleDeveloperDoctrine,
  DEVELOPER_CHECKLIST_HEADINGS,
  extractDeveloperSection
} from '../../src/lib/dev-review-loop/developer-dispatch'

/**
 * The shape of the Developer doctrine that the dispatch driver and the
 * published-prose gate both read. The driver prepends the role file's short
 * version and the reference's two checklist sections to every fresh
 * developer session, extracting each by its exact heading; an absent heading
 * injects nothing, silently. These assertions make a later edit that empties
 * or renames one of them fail here instead.
 */

const root = resolveDoctrineRoot()

function doctrineFile(...segments: string[]): string {
  if (root === null) throw new Error('no doctrine root resolves from this checkout')
  return readFileSync(join(root, ...segments), 'utf8')
}

const roleFile = doctrineFile('roles', 'developer.md')
const reference = doctrineFile('roles', 'developer', 'reference.md')

describe('the developer role file short version', () => {
  const short = extractShortVersion(roleFile) ?? ''

  it('exists and sits inside the published word range', () => {
    expect(short.length).toBeGreaterThan(0)
    const words = countWords(short)
    expect(words).toBeGreaterThanOrEqual(SHORT_VERSION_MIN_WORDS)
    expect(words).toBeLessThanOrEqual(SHORT_VERSION_MAX_WORDS)
  })

  it('carries its four bold-led blocks, in order', () => {
    const positions = ROLE_BLOCKS.map((block) => short.indexOf(`**${block}`))
    for (const at of positions) expect(at).toBeGreaterThanOrEqual(0)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})

describe('the developer reference checklist sections', () => {
  it('carries both headings the driver injects, each with a body', () => {
    const lines = reference.split('\n').map((line) => line.trim())
    for (const heading of DEVELOPER_CHECKLIST_HEADINGS) {
      expect(lines).toContain(`## ${heading}`)
      expect(extractDeveloperSection(reference, heading).length).toBeGreaterThan(0)
    }
  })

  it('assembles into the injected block with the short version and both sections', () => {
    const assembled = assembleDeveloperDoctrine(extractShortVersion(roleFile), reference) ?? ''
    expect(assembled).toContain('**You own**')
    for (const heading of DEVELOPER_CHECKLIST_HEADINGS) expect(assembled).toContain(`## ${heading}\n\n`)
  })
})
