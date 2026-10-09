#!/usr/bin/env bun
/**
 * Rewrites, in place, the `sha256` of every entry already listed in the
 * scenario corpus's `baseline.loopSurface` whose file bytes changed. The
 * corpus is read and written as text and only the digest strings are
 * replaced, so no other byte moves: no reformatting, no added or removed
 * entries, and `baseline.commit` and `baseline.branch` stay as they are.
 * A second run with no change in between leaves the file byte-identical.
 *
 * Run it after a loop-module change and commit its result:
 *   bun apps/cli/scripts/refresh-loop-baseline.ts
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
export const CORPUS_REL = 'apps/cli/tests/fixtures/dev-review-engine-scenarios.json'
export const REFRESH_COMMAND = 'bun apps/cli/scripts/refresh-loop-baseline.ts'

function fileDigest(root: string, rel: string): string | null {
  const abs = join(root, rel)
  return existsSync(abs) ? createHash('sha256').update(readFileSync(abs)).digest('hex') : null
}

/** The corpus text with each listed loop module's digest replaced in place by its file's current digest. */
export function refreshLoopBaseline(corpusText: string, root: string = REPO_ROOT): string {
  const start = corpusText.indexOf('"loopSurface": [')
  if (start < 0) throw new Error('corpus has no baseline.loopSurface')
  const end = corpusText.indexOf(']', start)
  const section = corpusText.slice(start, end)
  const refreshed = section.replace(
    /("path":\s*"([^"]+)",\s*"sha256":\s*")([0-9a-f]{64})(")/g,
    (whole, head: string, path: string, _old: string, tail: string) => {
      const digest = fileDigest(root, path)
      return digest === null ? whole : `${head}${digest}${tail}`
    }
  )
  return corpusText.slice(0, start) + refreshed + corpusText.slice(end)
}

if (import.meta.main) {
  const corpusPath = join(REPO_ROOT, CORPUS_REL)
  const before = readFileSync(corpusPath, 'utf8')
  const after = refreshLoopBaseline(before)
  if (after !== before) writeFileSync(corpusPath, after)
  process.stdout.write(after === before ? 'loop baseline already current\n' : `refreshed ${CORPUS_REL}\n`)
}
