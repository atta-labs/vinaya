/**
 * Issue #660, O3, round 5 Principal ruling — "O3 becomes a check, and this
 * round closes it": four rounds of the reviewer naming individual sibling
 * fixtures by hand never converged (ninety-two test files under
 * `apps/cli/tests` start a real process). Rather than a fifth round of the
 * same, this file makes O3 mechanical: it walks the real tree, finds every
 * real-process CALL SITE that neither goes through the shared
 * `lib/process-fixture.ts` helper nor carries that helper's own two-halves
 * pattern (VINAYA_* env stripping plus an explicit kill-and-diagnose
 * budget) at that call's own scope, and requires every file with at least
 * one such call site to be named, by path, on `GRANDFATHERED_FILES` below.
 *
 * Round 5 review, BLOCKER F1 — the first version of this check compared the
 * env-strip and kill-budget PATTERNS against a file's WHOLE TEXT (or
 * treated any import of the shared helper as clearing the entire file),
 * which let one hardened call in a file hide a completely unrelated, fully
 * raw call elsewhere in the SAME file — exactly what happened to
 * `conformance/harness.ts`'s `ensureCliBuilt`, `commands/dispatch-task.test.ts`'s
 * identical build spawn, and `package-root.test.ts`'s `run()` CLI helper.
 * This version instead:
 *   - finds every real spawn call textually (skipping comments/strings so a
 *     doc comment that merely MENTIONS `spawn()` is never mistaken for one);
 *   - exempts a small set of inert setup utilities (`git`, `chmod`, `mkdir`,
 *     …) invoked by a literal or an obviously-named identifier — the
 *     category the ruling itself named as legitimately out of scope
 *     ("git, gh, ln, chmod, a fake vendor binary");
 *   - for every remaining call, requires the file as a whole to strip
 *     VINAYA_* somewhere (env-composition is legitimately threaded through
 *     parameters across functions — `conformance/harness.ts`'s
 *     `buildSandbox`/`SpawnRpcClient` split is the reference case) AND the
 *     call's own nearest TOP-LEVEL declaration (the function, class, or
 *     `it(...)`/`describe(...)` callback that contains it — never the whole
 *     file) to carry the kill-budget evidence, since budget/diagnostic is
 *     always co-located with the actual spawn in every real fixture this
 *     task has hardened.
 *
 * The list is data, not a waiver — it fails in every direction the ruling
 * names:
 *   - a NEW non-compliant file (not yet on the list) fails the build — the
 *     list can never grow silently;
 *   - a LISTED file that has since been migrated to the shared helper (or
 *     otherwise hardened inline) fails the build too — a stale grandfather
 *     entry is exactly as wrong as a missing one, since it would let a
 *     REGRESSION on that file hide behind an entry that no longer describes
 *     it;
 *   - a file that regresses back to a raw spawn call after being migrated
 *     re-appears as a new offender, caught by the first case.
 *
 * Burning this list down is a later task, not this round's — see the
 * changeset for this round's own count.
 *
 * Round 7 Principal ruling — "a shell is not a utility": `sh` and `bash`
 * were in `SAFE_UTILITY_COMMANDS` alongside `git`/`chmod`/`mkdir`, but a
 * shell doesn't do one fixed thing the way those do — it runs whatever
 * string it's handed, so `spawnSync('bash', ['-c', 'bun ...'])` (or the
 * `sh` equivalent) hid an arbitrary command, including the `vinaya` CLI or
 * a build, behind a "safe" wrapper the scan never looked past. Round 7
 * removes both from the safe list, which reclassified three files
 * (`claude-command-emitter.test.ts`, `claude-stop-hook-emitter.test.ts`,
 * `init.test.ts`) from silently-safe to real offenders; none of the three
 * already routed through the shared helper, so all three were added to
 * `GRANDFATHERED_FILES` below rather than hardened inline — that inline
 * work is the same later task the list's burn-down already is, not this
 * round's.
 *
 * Round 8 review closed two gaps the mechanism itself had, both in the
 * scan rather than in any one fixture:
 *   - HIGH (security) — `SPAWNS_REAL_PROCESS` matched neither `execSync`
 *     nor `exec`, though both run their argument through a shell exactly
 *     like the `sh -c`/`bash -c` case round 7 just closed; an
 *     `execSync('some command')` was completely invisible to the scan.
 *     Both are now matched. A bare `exec(` needed its own carve-out
 *     (`(?<!\.)`, see `SPAWNS_REAL_PROCESS`'s own comment) so it doesn't
 *     collide with the unrelated `RegExp.prototype.exec` idiom this very
 *     file (and six others) use for pattern matching.
 *   - MEDIUM (security) — `isSafeCommand`'s identifier fallback matched
 *     any hint merely containing "git" by NAME (`gitLikeWrapper` would
 *     have scored safe regardless of what it resolves to at runtime); it
 *     now requires the file to prove the identifier resolves to the real
 *     git binary by assignment (see `identifierResolvesToGit`).
 * Re-running the scan with both fixes found no new offender and no stale
 * grandfather entry — `GRANDFATHERED_FILES` is unchanged at 55 entries.
 *
 * Round 9 review closed three precision gaps in the scan, no fixture
 * changes:
 *   - `fileHasVinayaStrip`/the kill-budget scope test ran against raw
 *     `content`, so a comment merely NAMING `stripVinayaEnv`/`SIGKILL`
 *     could mark a file compliant with no such code present. They now run
 *     against `stripComments`'s output (comments blanked, strings left
 *     intact — the real evidence is very often itself a string used as
 *     actual call/property syntax), and both patterns are tightened to
 *     require that call/property syntax rather than matching a bare word.
 *   - `SPAWNS_REAL_PROCESS` matched neither `execFile` in any form nor a
 *     member-call `exec` (`cp.exec(...)`) — the former is now in the main
 *     alternation (a dotted call included, since `execFile` has no
 *     `RegExp.prototype`-style collision), the latter matched separately
 *     via `MEMBER_EXEC`, gated on the receiver provably resolving to
 *     `node:child_process` (`identifierResolvesToChildProcess`).
 *   - This comment and the changeset said ninety-two test files start a
 *     real process; the scan (as fixed above) reports ninety-one.
 * Re-running the fixed scan found no new offender and no stale grandfather
 * entry — `GRANDFATHERED_FILES` is unchanged at 55 entries after round 9.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const TESTS_ROOT = join(REPO_ROOT, 'apps/cli/tests')
const HELPER_PATH = 'apps/cli/tests/lib/process-fixture.ts'

function walk(dir: string, prefix: string): [string, string][] {
  const out: [string, string][] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const abs = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') continue
    if (entry.isDirectory()) {
      out.push(...walk(abs, rel))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    out.push([rel, abs])
  }
  return out
}

/** Every `.ts`/`.tsx` file under `apps/cli/tests`, repo-relative, the helper itself excluded. */
function allTestTreeFiles(): [string, string][] {
  return walk(TESTS_ROOT, 'apps/cli/tests').filter(([rel]) => rel !== HELPER_PATH)
}

/**
 * `content` with every line comment, block comment, and string/template
 * literal replaced by same-length whitespace (newlines preserved, so every
 * OTHER index — and therefore every line number computed from it — stays
 * aligned with the original text). Used only to decide where a real call
 * sits; a doc comment's prose (`` `spawn()` `` in backticks, or a regex
 * literal spelling out `execFileSync(` as a string to describe the shape,
 * as `log-callers.test.ts` does) can never be mistaken for one.
 */
function stripNonCode(content: string): string {
  const out: string[] = []
  let i = 0
  const n = content.length
  while (i < n) {
    const c = content[i]
    if (c === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      out.push(' '.repeat(end - i))
      i = end
      continue
    }
    if (c === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out.push(content.slice(i, stop).replace(/[^\n]/g, ' '))
      i = stop
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      let j = i + 1
      while (j < n && content[j] !== quote) {
        if (content[j] === '\\') j++
        j++
      }
      j++
      out.push(content.slice(i, j).replace(/[^\n]/g, ' '))
      i = j
      continue
    }
    out.push(c as string)
    i++
  }
  return out.join('')
}

/**
 * `content` with every line comment and block comment replaced by
 * same-length whitespace — string/template literals are left INTACT,
 * unlike `stripNonCode` above. Used only for the two compliance regexes
 * (`HAS_VINAYA_ENV_STRIP`, `HAS_KILL_BUDGET`, round 9 finding 1): those
 * patterns' real evidence is often itself a string literal used as actual
 * call syntax — `killSignal: 'SIGKILL'`, `.kill('SIGKILL')`,
 * `startsWith('VINAYA_')` — so blanking every string the way `stripNonCode`
 * does would erase the real evidence along with a fake one. A comment
 * merely NAMING the mechanism has no such excuse and is blanked here
 * unconditionally; the compliance regexes are additionally tightened to
 * require call/property syntax (never a bare word) so a string that merely
 * *mentions* the mechanism in prose — with no real call attached — still
 * doesn't count.
 */
function stripComments(content: string): string {
  const out: string[] = []
  let i = 0
  const n = content.length
  while (i < n) {
    const c = content[i]
    if (c === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      out.push(' '.repeat(end - i))
      i = end
      continue
    }
    if (c === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out.push(content.slice(i, stop).replace(/[^\n]/g, ' '))
      i = stop
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      let j = i + 1
      while (j < n && content[j] !== quote) {
        if (content[j] === '\\') j++
        j++
      }
      j++
      out.push(content.slice(i, j))
      i = j
      continue
    }
    out.push(c as string)
    i++
  }
  return out.join('')
}

/**
 * A real call — matched against `stripNonCode`'s output, never raw content.
 *
 * Round 8 security review, HIGH — `execSync`/`exec` were absent, despite
 * running their argument through a shell exactly like the `sh -c`/`bash -c`
 * case round 7 just closed; an `execSync('some command')` was completely
 * invisible to this scan. Both are now matched like every other real spawn.
 * A bare `exec(` needs its own negative lookbehind (`(?<!\.)`) — unlike
 * `execSync`/`execFileSync`, the plain word `exec` collides with
 * `RegExp.prototype.exec`, e.g. this very file's own `re.exec(codeOnly)`
 * loop, which is never a child-process spawn; excluding a preceding `.`
 * keeps that member-call idiom out while still catching a bare imported
 * `exec(cmd, cb)`.
 *
 * Round 9 finding 2 — bare `execFile(` (never `execFileSync`, already
 * matched) was entirely absent, so `import { execFile } from
 * 'node:child_process'; execFile('ls', cb)` was invisible. It's now matched
 * like every other bare spawn name — including a DOTTED call
 * (`cp.execFile(...)`), since `\b` matches at the `.`→word-char boundary
 * just as readily as at a bare call's own start, and `execFile` never
 * collides with an unrelated builtin the way plain `exec` collides with
 * `RegExp.prototype.exec`. A *member-call* `exec` (e.g. `cp.exec(cmd)`) was
 * separately invisible — the `(?<!\.)` carve-out excludes EVERY dotted
 * call, not just the `RegExp.prototype.exec` idiom it was written for, and
 * that idiom can't be told apart from a real `cp.exec(...)` by regex alone.
 * Member-call `exec` is matched separately, below
 * (`MEMBER_EXEC` plus `identifierResolvesToChildProcess`), gated on the
 * receiver provably resolving to the `node:child_process` module rather
 * than trusting the call syntax alone.
 */
const SPAWNS_REAL_PROCESS =
  /\b(?:spawnSync|execFileSync|execFile|execSync|fork|spawn)\s*\(|(?<!\.)\bexec\s*\(|Bun\.spawn(?:Sync)?\s*\(/g

/**
 * A member-call `exec(` — e.g. `cp.exec(cmd)` — matched separately from
 * `SPAWNS_REAL_PROCESS` since the bare-`exec` carve-out there excludes
 * every dotted call, including this real one. `execFile` needs no such
 * separate handling (see `SPAWNS_REAL_PROCESS`'s own comment). Only counted
 * as a spawn when `identifierResolvesToChildProcess` proves the receiver is
 * the `node:child_process` module — otherwise `pattern.exec(text)`
 * (`RegExp.prototype.exec`) would be a false positive, exactly the round 8
 * BLOCKER this file's own carve-out exists to avoid.
 */
const MEMBER_EXEC = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.exec\s*\(/g

/**
 * `hint` is only treated as a real `child_process` receiver if the file
 * proves it by binding — a namespace import (`import * as cp from
 * 'node:child_process'`) or a `require('child_process')` assignment — never
 * by the identifier's name alone, the same discipline `identifierResolvesToGit`
 * already applies to a safe-command hint.
 *
 * The import/require KEYWORD is matched against `codeOnly`
 * (`stripNonCode`'s output) — this file's OWN doc comments and test
 * fixtures spell out `import * as cp from 'node:child_process'` in
 * prose/strings to document and test this exact function; each such mention
 * lives entirely inside ONE string or comment, so `stripNonCode` blanks it
 * whole, keyword included, and it never reaches this match. A genuine
 * import's own module-specifier string is then read back from the ORIGINAL
 * `content` at that exact, now-verified-real position — the same
 * read-the-literal-from-original-text discipline `commandHint` already uses
 * — so the specifier is never confused with the blanked placeholder
 * `codeOnly` would otherwise leave in its place.
 */
function identifierResolvesToChildProcess(content: string, codeOnly: string, hint: string): boolean {
  const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Leading `\s*` absorbs the real whitespace between the prefix and the
  // specifier's opening quote in ORIGINAL content — the prefix regexes
  // below deliberately stop right at `from`/`require(` (no trailing `\s*`
  // of their own) so `m[0].length` never overshoots into codeOnly's
  // same-length BLANKED specifier, which `\s+` would otherwise swallow
  // wholesale (greedy, and blanked chars are whitespace too) clear past
  // where the real quote sits.
  const specifier = /^\s*['"](?:node:)?child_process['"]/
  const namespaceImportPrefix = new RegExp(`import\\s+\\*\\s+as\\s+${escaped}\\s+from`, 'g')
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = namespaceImportPrefix.exec(codeOnly)) !== null) {
    if (specifier.test(content.slice(m.index + m[0].length, m.index + m[0].length + 40))) return true
  }
  const requireAssignmentPrefix = new RegExp(`\\b${escaped}\\b\\s*=\\s*require\\(`, 'g')
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = requireAssignmentPrefix.exec(codeOnly)) !== null) {
    if (specifier.test(content.slice(m.index + m[0].length, m.index + m[0].length + 40))) return true
  }
  return false
}

/**
 * `lib/process-fixture.ts`'s own `stripVinayaEnv` — imported, or
 * reimplemented inline, anywhere in the file. Matched against
 * `stripComments` output (round 9 finding 1: a comment merely NAMING the
 * helper no longer counts) AND tightened to require call syntax —
 * `stripVinayaEnv(` (a call or its own declaration), never the bare word —
 * so a descriptive string that just mentions "stripVinayaEnv" in prose,
 * with no real call attached, doesn't count either.
 */
const HAS_VINAYA_ENV_STRIP = /startsWith\(\s*['"]VINAYA_['"]\s*\)|\bstripVinayaEnv\s*\(/

/**
 * An explicit kill-on-timeout budget — `lib/process-fixture.ts`'s own
 * `spawnSyncBudgeted`/`spawnBudgetedAsync`, or the same discipline
 * reimplemented inline, within the call's own top-level declaration.
 * Matched against `stripComments` output (round 9 finding 1) and tightened
 * to the two real call/property shapes this codebase actually uses —
 * `killSignal: 'SIGKILL'` (a spawn options object) or `.kill('SIGKILL')`
 * (a direct signal) — never the bare words, for the same reason
 * `HAS_VINAYA_ENV_STRIP` above requires call syntax.
 */
const HAS_KILL_BUDGET = /killSignal\s*:\s*['"]SIGKILL['"]|\.kill\(\s*['"]SIGKILL['"]\s*\)/

/**
 * Inert setup utilities — never the `vinaya` CLI, never a build, never
 * anything the O3 incident (a leaked `VINAYA_RUNTIME_DIR` racing a driver
 * lock, or a hang with no budget) is actually about. The ruling's own words
 * name this category explicitly as out of scope for this round ("git, gh,
 * ln, chmod, a fake vendor binary"). `bun`/`node`/`vinaya` are deliberately
 * NEVER in this set — those are the exact risk-bearing invocations.
 *
 * Round 7 review — `sh`/`bash` do NOT belong here and are deliberately
 * absent. Unlike `git`/`chmod`/`mkdir`, a shell doesn't do one fixed thing:
 * it runs whatever string it's handed, so a `spawnSync('bash', ['-c', 'bun
 * ...'])` (or the same via `sh -c`) hid an arbitrary — possibly
 * risk-bearing — command from this scan behind a "safe" wrapper. A shell
 * spawn is now classified exactly like any other real process.
 */
const SAFE_UTILITY_COMMANDS = new Set([
  'git',
  'chmod',
  'true',
  'mkdir',
  'which',
  'mkfifo',
  'cat',
  'ln',
  'kill',
  'jq',
  'ps',
  'rm',
  'cp',
  'touch',
  'id',
  'whoami'
])

/** The call's first argument — a literal (`'git'`, `['bun', …]`) or a bare identifier (`realGit`, `cmd`) — read from the ORIGINAL content (never `stripNonCode`'s blanked text, which would hide the literal's own quotes). */
function commandHint(content: string, matchEnd: number): string | null {
  const tail = content.slice(matchEnd, matchEnd + 40)
  const literal = /^\s*\[?\s*['"]([a-zA-Z0-9_./-]+)['"]/.exec(tail)
  if (literal) return literal[1] as string
  const identifier = /^\s*\[?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(tail)
  return identifier ? (identifier[1] as string) : null
}

/**
 * `hint` is only treated as a safe `git` invocation if the file itself
 * PROVES, by assignment, that it resolves to the real git binary — either
 * `= 'git'` directly, or the `which git` idiom this codebase's own
 * `writeFakeGit`-style helpers use (`execFileSync('which', ['git']...)`).
 *
 * Round 8 security review, MEDIUM — the prior version matched on the
 * identifier's NAME alone (anything containing "git", case-insensitively,
 * short of "bun"/"node"/"vinaya"), so `spawnSync(gitLikeWrapper, ...)`
 * would score safe regardless of what `gitLikeWrapper` actually resolved to
 * at runtime — nothing tied the name to the value. This traces the
 * identifier to its real assignment instead of trusting its spelling.
 */
function identifierResolvesToGit(content: string, hint: string): boolean {
  const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const assignment = new RegExp(
    `\\b${escaped}\\b\\s*=\\s*(?:execFileSync\\(\\s*['"]which['"]\\s*,\\s*\\[\\s*['"]git['"]|['"]git['"])`
  )
  return assignment.test(content)
}

function isSafeCommand(content: string, hint: string | null): boolean {
  if (!hint) return false
  if (SAFE_UTILITY_COMMANDS.has(hint)) return true
  return identifierResolvesToGit(content, hint)
}

/**
 * The [start, end) span of the smallest brace-delimited block that both (a)
 * opens at file-level nesting depth 0→1 and (b) contains `index` — the
 * call's own top-level function, class, or `it(...)`/`describe(...)`
 * callback. A class's constructor and its other methods share ONE span
 * (`conformance/harness.ts`'s `SpawnRpcClient`: the constructor spawns, a
 * SEPARATE method holds the kill-on-timeout budget — the same class, the
 * same span, correctly read as one unit), while two unrelated top-level
 * functions never share a span (the exact BLOCKER this round fixes).
 */
function topLevelSpans(content: string): [number, number][] {
  const spans: [number, number][] = []
  const stack: number[] = []
  let i = 0
  const n = content.length
  while (i < n) {
    const c = content[i]
    if (c === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (c === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < n && content[i] !== quote) {
        if (content[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (c === '{') {
      if (stack.length === 0) spans.push([i, -1])
      stack.push(i)
    } else if (c === '}') {
      stack.pop()
      if (stack.length === 0 && spans.length > 0) {
        const last = spans[spans.length - 1] as [number, number]
        if (last[1] === -1) last[1] = i + 1
      }
    }
    i++
  }
  return spans.filter((s) => s[1] !== -1)
}

function spanFor(spans: readonly [number, number][], index: number): [number, number] | null {
  for (const [start, end] of spans) {
    if (index >= start && index < end) return [start, end]
  }
  return null
}

/**
 * Every non-compliant real-process call site in `content` — a real spawn,
 * not an inert utility, whose containing file never strips VINAYA_*
 * anywhere, or whose own top-level declaration carries no kill-budget
 * evidence.
 *
 * Round 9 finding 1 — `fileHasVinayaStrip` and the kill-budget scope test
 * both now run against `stripComments`'s output, never raw `content`: a
 * comment merely NAMING `stripVinayaEnv` or `SIGKILL` used to be enough to
 * mark a file compliant with no such code actually present. String literals
 * are deliberately NOT blanked for these two checks (unlike `codeOnly`
 * below) — the real evidence itself is very often a string literal used as
 * actual call/property syntax (`killSignal: 'SIGKILL'`, `.kill('SIGKILL')`,
 * `startsWith('VINAYA_')`); `HAS_VINAYA_ENV_STRIP`/`HAS_KILL_BUDGET` are
 * tightened to require that call/property syntax instead, so a stray string
 * that merely *mentions* the mechanism in prose, with no real call
 * attached, still doesn't count. `stripComments` and `stripNonCode` both
 * preserve length and newlines, so slicing either by spans computed from
 * `content` stays aligned.
 */
function nonCompliantCallSites(content: string): string[] {
  const offenses: string[] = []
  const spans = topLevelSpans(content)
  const codeOnly = stripNonCode(content)
  const commentsStripped = stripComments(content)
  const fileHasVinayaStrip = HAS_VINAYA_ENV_STRIP.test(commentsStripped)

  const matches: { index: number; text: string }[] = []
  const re = new RegExp(SPAWNS_REAL_PROCESS.source, 'g')
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((match = re.exec(codeOnly)) !== null) {
    matches.push({ index: match.index, text: match[0] })
  }
  const memberRe = new RegExp(MEMBER_EXEC.source, 'g')
  let memberMatch: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((memberMatch = memberRe.exec(codeOnly)) !== null) {
    const receiver = memberMatch[1] as string
    if (!identifierResolvesToChildProcess(content, codeOnly, receiver)) continue
    matches.push({ index: memberMatch.index, text: memberMatch[0] })
  }
  matches.sort((a, b) => a.index - b.index)

  for (const { index, text } of matches) {
    const hint = commandHint(content, index + text.length)
    if (isSafeCommand(content, hint)) continue
    const span = spanFor(spans, index)
    const scope = span ? commentsStripped.slice(span[0], span[1]) : commentsStripped
    if (!(fileHasVinayaStrip && HAS_KILL_BUDGET.test(scope))) {
      const line = content.slice(0, index).split('\n').length
      offenses.push(`line ${line}: ${text}`)
    }
  }
  return offenses
}

function isNonCompliant(content: string): boolean {
  return nonCompliantCallSites(content).length > 0
}

/**
 * Round 5's own fix: the two build spawns (`package-root.test.ts`,
 * `commands/check-json-pipe.test.ts`), the webhook-drain fixture
 * (`lib/log-webhook-drain.test.ts` — the sibling GitHub-comment-posting
 * fixtures it once stood alongside are deleted, task-files-v1 6, O1), and
 * the three round-4-named sites (`lib/dev-review-loop/gate-reading.test.ts`,
 * `conformance/harness.ts`, `commands/dispatch-task.test.ts`) are all NOT on
 * this list — proven by the negative assertion below, so a regression on any
 * of them is caught as a new offender rather than silently re-covered by a
 * stale entry.
 * `commands/task-status.test.ts` and `lib/dispatch.test.ts` (already fully
 * migrated in earlier rounds) are also absent — this round's move to
 * call-site precision re-verified both and found no gap.
 *
 * Every other file below still spawns a real process (`git`, a fake vendor
 * binary, or the `vinaya` CLI itself for a command that never touches the
 * runtime-dir/driver-lock/control-store surface the original incident was
 * about) without the shared helper's pattern at that call's own scope.
 * Found by search — `bun apps/cli/tests/process-fixture-coverage.test.ts`'s
 * own scan — never by memory, per round 3's ruling.
 *
 * Round 7 adds exactly three entries — `claude-command-emitter.test.ts`,
 * `claude-stop-hook-emitter.test.ts`, `init.test.ts` — the files
 * reclassified by removing `sh`/`bash` from `SAFE_UTILITY_COMMANDS`. The
 * list holds 55 entries as of round 7 (52 carried over from round 5 plus
 * these three); round 5's own list of names above this comment is
 * unchanged and still accurate for what it describes.
 */
const GRANDFATHERED_FILES: readonly string[] = [
  'apps/cli/tests/checks/body-bare-digits-changeset-exempt.test.ts',
  'apps/cli/tests/checks/branch-topology.test.ts',
  'apps/cli/tests/checks/changeset-coverage-bin.test.ts',
  'apps/cli/tests/checks/check-dispatch-readiness-premise.test.ts',
  'apps/cli/tests/checks/check-exec-bits.test.ts',
  'apps/cli/tests/checks/check-review-gate-objectives.test.ts',
  'apps/cli/tests/checks/check-review-gate-true-head.test.ts',
  'apps/cli/tests/checks/check-workspace-escape.test.ts',
  'apps/cli/tests/checks/core-parity.test.ts',
  'apps/cli/tests/checks/doc-neutral-ci-parity.test.ts',
  'apps/cli/tests/checks/evidence-fresh.test.ts',
  'apps/cli/tests/checks/issue-checks.test.ts',
  'apps/cli/tests/checks/prose-gates-doctrine-root.test.ts',
  'apps/cli/tests/checks/quoted-command-bin.test.ts',
  'apps/cli/tests/checks/registry-gates.test.ts',
  'apps/cli/tests/checks/repo-root-resolution.test.ts',
  'apps/cli/tests/checks/runner.test.ts',
  'apps/cli/tests/checks/runner/cancelled.test.ts',
  'apps/cli/tests/checks/surface-scope.test.ts',
  'apps/cli/tests/checks/token-collection-pointer-hardening.test.ts',
  'apps/cli/tests/claude-command-emitter.test.ts',
  'apps/cli/tests/claude-stop-hook-emitter.test.ts',
  'apps/cli/tests/commands/brief-render.test.ts',
  'apps/cli/tests/commands/check-flip.test.ts',
  'apps/cli/tests/commands/check-roles-plan.test.ts',
  'apps/cli/tests/commands/check.test.ts',
  'apps/cli/tests/commands/issue-objectives.test.ts',
  'apps/cli/tests/commands/issue.test.ts',
  'apps/cli/tests/commands/pr-create-brief-comment.test.ts',
  'apps/cli/tests/commands/pr-rule.test.ts',
  'apps/cli/tests/commands/pr-verify-evidence-cwd.test.ts',
  'apps/cli/tests/commands/pr.test.ts',
  'apps/cli/tests/commands/review-post-print-only.test.ts',
  'apps/cli/tests/commands/review-post.test.ts',
  'apps/cli/tests/commands/review-status.test.ts',
  'apps/cli/tests/commands/task.test.ts',
  'apps/cli/tests/doctrine-resolution.test.ts',
  'apps/cli/tests/doctrine.test.ts',
  'apps/cli/tests/fixtures/checks/spawns-grandchild.ts',
  'apps/cli/tests/fixtures/checks/spawns-stubborn-grandchild.ts',
  'apps/cli/tests/init.test.ts',
  'apps/cli/tests/isolation/isolation-probe.test.ts',
  'apps/cli/tests/lib/dispatch/worker-boundary.test.ts',
  'apps/cli/tests/lib/forge-write.test.ts',
  'apps/cli/tests/lib/test-selector.test.ts',
  'apps/cli/tests/lib/turbo-test-task-uncached.test.ts',
  'apps/cli/tests/milestone.test.ts',
  'apps/cli/tests/new-check.test.ts',
  'apps/cli/tests/new-noop-check.test.ts',
  'apps/cli/tests/new-role.test.ts',
  'apps/cli/tests/ops.test.ts',
  'apps/cli/tests/pr-report.test.ts',
  'apps/cli/tests/review-post.test.ts'
]

describe('process-fixture coverage — O3 (#660, round 5): every real-process fixture is tracked, not remembered', () => {
  const files = allTestTreeFiles()

  it('the scan really walks the tree — not vacuously empty', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('the shared helper itself really implements both halves of the pattern', () => {
    const helperAbs = join(REPO_ROOT, HELPER_PATH)
    expect(existsSync(helperAbs), `${HELPER_PATH} not found`).toBe(true)
    const content = readFileSync(helperAbs, 'utf8')
    expect(content).toContain('export function stripVinayaEnv')
    expect(content).toContain('export function spawnSyncBudgeted')
    expect(content).toContain('export async function spawnBudgetedAsync')
    expect(HAS_KILL_BUDGET.test(content)).toBe(true)
  })

  it('no new non-compliant real-process call site exists outside the grandfather list — the list never grows silently', () => {
    const grandfathered = new Set(GRANDFATHERED_FILES)
    const newOffenders = files
      .filter(([rel]) => !grandfathered.has(rel))
      .filter(([, abs]) => isNonCompliant(readFileSync(abs, 'utf8')))
      .map(([rel]) => rel)
    expect(newOffenders).toEqual([])
  })

  it('every grandfathered file is still genuinely non-compliant — a migrated file must be removed from the list, not left to hide a future regression behind a stale entry', () => {
    const stale = GRANDFATHERED_FILES.filter((rel) => {
      const entry = files.find(([r]) => r === rel)
      if (!entry) return false // a missing/renamed file is caught by the next test instead
      return !isNonCompliant(readFileSync(entry[1], 'utf8'))
    })
    expect(stale).toEqual([])
  })

  it('the grandfather list names no duplicate and no nonexistent file', () => {
    const existing = new Set(files.map(([rel]) => rel))
    expect(new Set(GRANDFATHERED_FILES).size).toBe(GRANDFATHERED_FILES.length)
    const missing = GRANDFATHERED_FILES.filter((rel) => !existing.has(rel))
    expect(missing).toEqual([])
  })

  it("round 5's own migrated/hardened files are compliant, not grandfathered — the check is not vacuous against a real fix", () => {
    const fixed = [
      'apps/cli/tests/package-root.test.ts',
      'apps/cli/tests/commands/check-json-pipe.test.ts',
      'apps/cli/tests/lib/log-webhook-drain.test.ts',
      'apps/cli/tests/lib/dev-review-loop/gate-reading.test.ts',
      'apps/cli/tests/conformance/harness.ts',
      'apps/cli/tests/commands/dispatch-task.test.ts',
      // Issue #670, O2 — the two dispatch test files hardened by that task's
      // own pid-capture-and-group-kill fixtures (`killLaunchedChild`) and its
      // new host-wide process-hygiene proof (a bare `execSync` call, covered
      // by this file's own file-wide VINAYA_ strip plus its own local
      // `killSignal: 'SIGKILL'` budget) — proven compliant here, by name,
      // rather than left to the silent absence from `GRANDFATHERED_FILES`
      // this round's review found insufficient on its own.
      'apps/cli/tests/lib/dispatch.test.ts',
      'apps/cli/tests/lib/dispatch/reconcile-launch.test.ts'
    ]
    for (const rel of fixed) {
      expect(GRANDFATHERED_FILES).not.toContain(rel)
      const abs = files.find(([r]) => r === rel)?.[1]
      expect(abs, `${rel} not found by the scan`).toBeDefined()
      const content = readFileSync(abs as string, 'utf8')
      expect(isNonCompliant(content), `${rel}: ${nonCompliantCallSites(content).join(', ')}`).toBe(false)
    }
  })

  it('the call-site check catches a raw call hiding behind an unrelated hardened one in the same file — the exact BLOCKER round 5 review found', () => {
    // Line 11 (`stillRaw`'s own spawnSync) is the only offense expected —
    // line 8 (`hardened`'s spawnSync) carries the pattern at its own call
    // site, and the two functions must NOT be conflated into one scope.
    const twoFunctionsOneHardenedOneRaw = [
      "import { spawnSync } from 'node:child_process'",
      'function stripVinayaEnv(env) {',
      '  const out = { ...env }',
      "  for (const k of Object.keys(out)) if (k.startsWith('VINAYA_')) delete out[k]",
      '  return out',
      '}',
      'function hardened() {',
      "  return spawnSync('bun', ['x'], { env: stripVinayaEnv(process.env), timeout: 1000, killSignal: 'SIGKILL' })",
      '}',
      'function stillRaw() {',
      "  return spawnSync('bun', ['y'], { env: process.env })",
      '}'
    ].join('\n')

    const offenses = nonCompliantCallSites(twoFunctionsOneHardenedOneRaw)
    expect(offenses).toEqual(['line 11: spawnSync('])
  })

  it('an execSync/exec call is caught exactly like any other real spawn — the round 8 security BLOCKER', () => {
    const raw = [
      "import { execSync } from 'node:child_process'",
      'function rawExecSync() {',
      "  return execSync('ps -eo pid,command')",
      '}'
    ].join('\n')
    expect(nonCompliantCallSites(raw)).toEqual(['line 3: execSync('])

    const hardened = [
      "import { execSync } from 'node:child_process'",
      'function stripVinayaEnv(env) {',
      '  const out = { ...env }',
      "  for (const k of Object.keys(out)) if (k.startsWith('VINAYA_')) delete out[k]",
      '  return out',
      '}',
      'function hardenedExecSync() {',
      "  return execSync('ps -eo pid,command', { env: stripVinayaEnv(process.env), timeout: 1000, killSignal: 'SIGKILL' })",
      '}'
    ].join('\n')
    expect(nonCompliantCallSites(hardened)).toEqual([])
  })

  it("a bare `exec(` is never confused with `RegExp.prototype.exec` — the round 8 false-positive this file's own `re.exec(codeOnly)` loop would otherwise trip", () => {
    const regexpExec = ['function findMatch(pattern, text) {', '  return pattern.exec(text)', '}'].join('\n')
    expect(nonCompliantCallSites(regexpExec)).toEqual([])
  })

  it('isSafeCommand\'s git identifier fallback requires a real `which git`/literal resolution, not just a name containing "git" — the round 8 security MEDIUM', () => {
    const namedButUnresolved = [
      "import { execFileSync } from 'node:child_process'",
      'function run(gitLikeWrapper) {',
      "  return execFileSync(gitLikeWrapper, ['status'])",
      '}'
    ].join('\n')
    expect(nonCompliantCallSites(namedButUnresolved)).toEqual(['line 3: execFileSync('])

    const namedAndResolved = [
      "import { execFileSync } from 'node:child_process'",
      "const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()",
      'function run() {',
      "  return execFileSync(realGit, ['status'])",
      '}'
    ].join('\n')
    expect(nonCompliantCallSites(namedAndResolved)).toEqual([])
  })

  it('a comment or string merely naming stripVinayaEnv/SIGKILL never fakes compliance — the round 9 finding 1 regression', () => {
    const claimsComplianceInACommentOnly = [
      "import { spawnSync } from 'node:child_process'",
      '// this file already calls stripVinayaEnv and passes killSignal: SIGKILL, honest',
      'function rawSpawn() {',
      "  return spawnSync('bun', ['x'], { env: process.env })",
      '}'
    ].join('\n')
    expect(nonCompliantCallSites(claimsComplianceInACommentOnly)).toEqual(['line 4: spawnSync('])

    const claimsComplianceInAStringOnly = [
      "import { spawnSync } from 'node:child_process'",
      "const note = 'calls stripVinayaEnv and sets killSignal: SIGKILL'",
      'function rawSpawn() {',
      "  return spawnSync('bun', ['x'], { env: process.env })",
      '}'
    ].join('\n')
    expect(nonCompliantCallSites(claimsComplianceInAStringOnly)).toEqual(['line 4: spawnSync('])
  })

  it('a bare execFile( and a member-call exec/execFile resolved to node:child_process are caught like any other real spawn — the round 9 finding 2 regression', () => {
    const bareExecFile = [
      "import { execFile } from 'node:child_process'",
      'function rawExecFile() {',
      "  return execFile('ls', () => {})",
      '}'
    ].join('\n')
    expect(nonCompliantCallSites(bareExecFile)).toEqual(['line 3: execFile('])

    const memberExec = [
      "import * as cp from 'node:child_process'",
      'function rawMemberExec() {',
      "  return cp.exec('ls -la')",
      '}'
    ].join('\n')
    expect(nonCompliantCallSites(memberExec)).toEqual(['line 3: cp.exec('])

    // `execFile` needs no member-call carve-out (unlike `exec`) — `\b`
    // matches at the `.`→word-char boundary just as readily as at a bare
    // call, so the main `SPAWNS_REAL_PROCESS` regex alone catches a dotted
    // `cp.execFile(` too, matching only the `execFile(` word itself.
    const memberExecFile = [
      "const cp = require('child_process')",
      'function rawMemberExecFile() {',
      "  return cp.execFile('ls', () => {})",
      '}'
    ].join('\n')
    expect(nonCompliantCallSites(memberExecFile)).toEqual(['line 3: execFile('])

    // An unresolved receiver — never proven to be `node:child_process` — is
    // still never confused with a real spawn, the same false-positive the
    // round 8 bare-`exec` carve-out protects against for the non-member form.
    const unresolvedMemberExec = ['function findMatch(pattern, text) {', '  return pattern.exec(text)', '}'].join('\n')
    expect(nonCompliantCallSites(unresolvedMemberExec)).toEqual([])
  })
})
