import { execFileSync } from 'node:child_process'

/**
 * A pull request's OWN patch at `sha`: the zero-context diff from the one merge
 * base `sha` shares with `base`, to `sha`. Zero context is what keeps the
 * default branch out of it — a merge from the base moves the lines around the
 * pull request's own changes and adds lines of its own, and neither is the pull
 * request's patch — and the merge base is each candidate's own, so a head from
 * before a merge of the default branch and the merge itself are each diffed
 * against the base they actually sit on.
 *
 * `base` and `sha` are revisions the caller has frozen (a resolved sha, or a
 * ref it owns); `fetch` names how a missing object is fetched first (the CI
 * gate's `git fetch origin <rev>`), and the driver, whose objects are already
 * in its own worktree, passes none. Null on every uncertainty, never "the
 * same": an object git cannot read, no merge base, more than one (an ambiguous
 * criss-cross history), or an empty patch.
 *
 * The patch identity (`ownPatchIdAt`), the interdiff (`ownPatchInterdiff`) and
 * the base-branch form (`patchIdAt`) are all read through this one patch.
 */

/** Where an own patch is read: the repository, and how a missing object is fetched. */
export interface OwnPatchOptions {
  /** The repository directory; the process's own when absent. */
  cwd?: string
  /** Fetches one revision before it is read; absent, nothing is fetched. */
  fetch?: (rev: string) => void
}

const git = (args: readonly string[], options: OwnPatchOptions, input?: string): string =>
  execFileSync('git', [...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input, stdio: ['pipe', 'pipe', 'pipe'] })
  })

/** The zero-context own patch of `sha` against `base`, as git prints it (above); null when it cannot be read unambiguously. */
export function ownPatchAt(base: string, sha: string, options: OwnPatchOptions = {}): string | null {
  for (const rev of [base, sha]) {
    try {
      options.fetch?.(rev)
    } catch {
      // Non-fatal on its own: the object may already be local. The reads below are the real test.
    }
  }
  try {
    const bases = git(['merge-base', '--all', base, sha], options)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (bases.length !== 1) return null
    const diff = git(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', bases[0] as string, sha], options)
    return diff === '' ? null : diff
  } catch {
    return null
  }
}

/** `git patch-id --stable` of `sha`'s own patch against `base` (`ownPatchAt`); null when that patch is. */
export function ownPatchIdAt(base: string, sha: string, options: OwnPatchOptions = {}): string | null {
  const diff = ownPatchAt(base, sha, options)
  if (diff === null) return null
  try {
    const id = git(['patch-id', '--stable'], options, diff).trim().split(/\s+/)[0] ?? ''
    return id === '' ? null : id
  } catch {
    return null
  }
}

/**
 * An own patch with what only its position says left out: each hunk header's
 * line numbers (main's lines above it move them) and each file's `index` line
 * (the blobs carry main's lines too). What is left is the pull request's own
 * changed lines, file by file, in order.
 */
function positionFree(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => (line.startsWith('@@') ? '@@' : line))
    .join('\n')
}

/**
 * The interdiff between two own patches of one pull request — before and after
 * a repair — against the same frozen `base`: a unified diff of the first own
 * patch's text to the second's, position-free (`positionFree`), so a line only
 * the default branch added never appears in it, and neither does a line that
 * only moved. Null when either own patch cannot be read, or when they are
 * identical once positions are left out.
 */
export function ownPatchInterdiff(
  base: string,
  before: string,
  after: string,
  options: OwnPatchOptions = {}
): string | null {
  const old = ownPatchAt(base, before, options)
  const now = ownPatchAt(base, after, options)
  if (old === null || now === null) return null
  const oldLines = positionFree(old).split('\n')
  const newLines = positionFree(now).split('\n')
  if (oldLines.join('\n') === newLines.join('\n')) return null
  return [`--- own patch at ${before}`, `+++ own patch at ${after}`, ...lineDiff(oldLines, newLines)].join('\n')
}

/** The largest middle section (old lines times new lines) the line diff matches line by line. */
const MAX_LINE_DIFF_CELLS = 4_000_000

/**
 * A whole-text line diff, each line marked ` `, `-` or `+`, keeping three
 * unchanged lines around each change and `@@` between separate changes. The
 * common head and tail are matched first; the middle by longest common
 * subsequence, or — past `MAX_LINE_DIFF_CELLS` — replaced whole.
 */
function lineDiff(a: readonly string[], b: readonly string[]): string[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const middle: string[] = []
  if (midA.length * midB.length > MAX_LINE_DIFF_CELLS) {
    middle.push(...midA.map((line) => `-${line}`), ...midB.map((line) => `+${line}`))
  } else {
    const n = midA.length
    const m = midB.length
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        middle.push(` ${midA[i]}`)
        i++
        j++
      } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
        middle.push(`+${midB[j]}`)
        j++
      } else {
        middle.push(`-${midA[i]}`)
        i++
      }
    }
  }
  const all = [
    ...a.slice(0, head).map((line) => ` ${line}`),
    ...middle,
    ...a.slice(a.length - tail).map((l) => ` ${l}`)
  ]
  const changed = all.map((line) => !line.startsWith(' '))
  const kept: string[] = []
  let last = -1
  for (let k = 0; k < all.length; k++) {
    let near = false
    for (let d = -3; d <= 3 && !near; d++) near = changed[k + d] === true
    if (!near) continue
    if (last !== -1 && k > last + 1) kept.push('@@')
    kept.push(all[k] as string)
    last = k
  }
  return kept
}

/** Fetches `rev` from `origin`, quietly; the CI gate's and the evidence check's fetch. */
export function fetchFromOrigin(rev: string): void {
  execFileSync('git', ['fetch', '--quiet', 'origin', rev], { stdio: ['ignore', 'ignore', 'ignore'] })
}

/**
 * A commit's patch identity against the base branch `base`: its own patch
 * (`ownPatchIdAt`) against `origin/<base>`, with the commit fetched first —
 * after a push, the judged head is no longer anything local git has. A null
 * is "cannot answer", never "they match", so a genuinely unreachable commit (a
 * force-push that discarded it) stops counting rather than silently passing.
 *
 * Shared by `check-review-gate.ts` (a verdict binds to a PATCH, not a sha;
 * the gate passes its frozen base sha through `ownPatchIdAt` itself), the
 * standalone loop's carried-verdict check, and `check-evidence-fresh.ts`
 * (the freshness check's own `Head:` binding uses the identical rule) — one
 * comparison, not two.
 */
export function patchIdAt(base: string, sha: string): string | null {
  return ownPatchIdAt(`origin/${base}`, sha, { fetch: (rev) => (rev === sha ? fetchFromOrigin(sha) : undefined) })
}
