/**
 * The key a test file's complete pass is kept under, and the one rule that
 * decides whether an earlier pass still holds at another commit.
 *
 * A key is the verification context the test ran under plus the content of
 * every path it reads. The paths are the test's recorded reads when the
 * record holds the test and none of those paths changed between the record's
 * commit and the commit being keyed; otherwise — no record, an unusable one,
 * or a recorded path that changed since — the whole tracked tree. So an
 * earlier pass is reused only when nothing it could have read differs. A key
 * that cannot be computed (no context, an unreadable revision) is `null`, and
 * a `null` key never matches.
 */
import { createHash } from 'node:crypto'
import { stableHash } from './inventory.js'
import type { RecordedTest } from './recorded-reads.js'
import type { RepositoryReader, SelectionRecords } from './types.js'

export type PassKeyInput = {
  repo: RepositoryReader
  /** The commit the key is computed at: the commit the test ran on, or the head a selection plans. */
  revision: string
  /** The verification context digest; `null` gives no key. */
  context: string | null
  /** The record of what each test read, when one was reached. */
  records?: SelectionRecords | null
}

/** Computes keys for many tests at one revision, reading each listing and the whole tree's digest once. */
export function passKeys(input: PassKeyInput): (test: string) => string | null {
  const { repo, revision, context, records } = input
  const listings = new Map<string, readonly string[] | null>()
  const listing = (rev: string): readonly string[] | null => {
    if (!listings.has(rev)) {
      try {
        listings.set(rev, repo.list(rev))
      } catch {
        listings.set(rev, null)
      }
    }
    return listings.get(rev) ?? null
  }
  const contentOf = (rev: string, path: string): string | null => {
    const id = repo.identity?.(rev, path)
    if (id) return id
    const text = repo.read(rev, path)
    return text === null ? null : createHash('sha256').update(text).digest('hex')
  }
  let treeDigest: string | null | undefined
  const wholeTree = (): string | null => {
    if (treeDigest === undefined) {
      const paths = listing(revision)
      treeDigest = paths === null ? null : stableHash(paths.map((path) => [path, contentOf(revision, path)]))
    }
    return treeDigest
  }
  const recordPaths = (rev: string, entry: RecordedTest, test: string): string[] | null => {
    const paths = listing(rev)
    if (paths === null) return null
    const exact = new Set([test, ...entry.reads.filter((read) => !read.endsWith('/'))])
    const folders = [
      ...entry.reads.filter((read) => read.endsWith('/')),
      ...entry.listed.map((folder) => (folder === '.' ? '' : folder.endsWith('/') ? folder : `${folder}/`))
    ]
    return [...new Set([...exact, ...paths.filter((path) => folders.some((folder) => path.startsWith(folder)))])].sort()
  }
  return (test) => {
    if (context === null) return null
    const record = records?.record
    const entry = record?.tests[test]
    const usable =
      record !== undefined &&
      entry !== undefined &&
      !entry.fallback &&
      !(entry.branchesOnPlatform && record.platform !== records?.platform)
    if (usable && record && entry) {
      const now = recordPaths(revision, entry, test)
      const then = recordPaths(record.commit, entry, test)
      if (now !== null && then !== null) {
        const files = now.map((path) => [path, contentOf(revision, path)])
        const unchanged =
          now.length === then.length &&
          now.every((path, i) => path === then[i] && contentOf(record.commit, path) === contentOf(revision, path))
        if (unchanged) return stableHash({ context, test, scope: 'record', files })
      }
    }
    const tree = wholeTree()
    return tree === null ? null : stableHash({ context, test, scope: 'tree', tree })
  }
}

/** The key of one test's pass at one revision; see {@link passKeys}. */
export function passEntryKey(input: PassKeyInput & { test: string }): string | null {
  return passKeys(input)(input.test)
}
