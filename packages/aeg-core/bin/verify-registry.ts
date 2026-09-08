#!/usr/bin/env bun

/**
 * verify-registry — G1–G6, the deterministic checks that make
 * `aeg-root/enforcement.md`'s three ring tables load-bearing (aeg-core-purity
 * discipline: this is the thin I/O shim; the pure evaluators live in
 * `../src/registry-parse.ts` / `../src/registry-checks.ts`).
 *
 * Rollout policy: G1 and G2 (both re-graded blocking in this same wave)
 * and G3/G4/G5 are blocking: the process exits non-zero if any of them
 * returns `'fail'`.
 *
 * G6 does NOT run from this standalone bin: it needs `coreCheckRegistry()`,
 * which lives in `apps/cli` and `aeg-core` cannot import without closing a
 * dependency cycle (same reasoning `gate-audience.ts` documents). Run
 * `apps/cli/src/checks/bin/check-registry-gates.ts` (or `vinaya check
 * registry-gates`) for the full G1–G6 gate set.
 *
 * `--scaffold`: auto-inserts a stub row for every G2 orphan candidate whose
 * ring is derivable (registry-scaffold.ts), writes `aeg-root/enforcement.md`,
 * and prints what it inserted. Deliberately only here, never in the shipped
 * `check-registry-gates.ts` (apps/cli) — adopter checks stay read-only over
 * doctrine; this repo's own maintainers run the writer directly, from
 * aeg-core, exactly like every other `bin/verify-*.ts` gate. Without the
 * flag, behavior is unchanged.
 *
 * Usage: bun packages/aeg-core/bin/verify-registry.ts [--scaffold]
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import {
  applyScaffoldPlan,
  checkG1,
  checkG2,
  checkG3,
  checkG4,
  checkG5,
  computeScaffoldPlan,
  parseEnforcementRegistry
} from '../src/index'
import type { GateRow, RegistryCheckResult } from '../src/index'

const REPO_ROOT = join(import.meta.dirname, '../../..')
process.chdir(REPO_ROOT)

const ENFORCEMENT_PATH = 'aeg-root/enforcement.md'
const ROLES_DIR = 'aeg-root/roles'
const CONTRACTS_DIR = 'aeg-root/contracts'

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

// ---------- G1: implementation paths resolve on disk -------------------------

function existsFn(path: string): boolean {
  return existsSync(join(REPO_ROOT, path))
}

// ---------- G2: candidate hook/CLI files --------------------------------------

/**
 * `.husky/*` (excluding the `_` internal dir), `.claude/hooks/*.sh`,
 * `packages/aeg-core/bin/*.ts`, and `apps/cli/src/checks/bin/*.ts` (each
 * excluding `*.test.ts` — tests aren't hooks/CLIs that enforcement.md would
 * ever register; including them would flood G2 with noise the brief's own
 * dig never contemplated). The fourth location (Issue #307) is where most
 * core check bins actually live — the classifier (`registry-scaffold.ts`)
 * can only place a stub for a candidate reaching it from here.
 */
function globCandidateFiles(): string[] {
  const out: string[] = []

  // Neither `.husky/` nor `.claude/hooks/` exists in this repo today
  // (enforcement.md's own G2 row notes this) — guarded the same way as the
  // `.claude/hooks` glob just below, so a repo carrying neither directory
  // (the live case here) doesn't crash before G1–G5 ever run. Pre-existing
  // gap, not introduced by this task: unguarded, this call threw ENOENT on
  // a totally clean `origin/main` checkout, which made
  // `bun packages/aeg-core/bin/verify-registry.ts` unable to establish even
  // a baseline pass — fixed here since it blocks this task's own pre-flight
  // and the live `--scaffold` run below.
  const huskyDir = join(REPO_ROOT, '.husky')
  if (existsSync(huskyDir)) {
    for (const name of readdirSync(huskyDir)) {
      if (name === '_') continue
      const rel = `.husky/${name}`
      if (statSync(join(REPO_ROOT, rel)).isFile()) out.push(rel)
    }
  }

  const hooksDir = join(REPO_ROOT, '.claude/hooks')
  if (existsSync(hooksDir)) {
    for (const name of readdirSync(hooksDir)) {
      if (name.endsWith('.sh')) out.push(`.claude/hooks/${name}`)
    }
  }

  const binDir = join(REPO_ROOT, 'packages/aeg-core/bin')
  for (const name of readdirSync(binDir)) {
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(`packages/aeg-core/bin/${name}`)
    }
  }

  const cliBinDir = join(REPO_ROOT, 'apps/cli/src/checks/bin')
  for (const name of readdirSync(cliBinDir)) {
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(`apps/cli/src/checks/bin/${name}`)
    }
  }

  return out
}

// ---------- G3: GitHub-crossing (create/body-edit) files ----------------------

/**
 * Matches the exact mutation classes `.claude/hooks/check-forge-gates.sh`
 * itself intercepts (PR/Issue create, PR/Issue body/title edit, `gh api`
 * POST to `/pulls`|`/issues` or PATCH to `/pulls/N`|`/issues/N`, raw
 * curl/wget writes) — that hook's own comment is explicit that
 * comments/labels/close/reopen/merge are "sanctioned append operations",
 * not gated. Scoping crossingFiles any broader (e.g. to every file that
 * merely shells `gh issue view`) would flag
 * `archive-task.ts`/`dead-branch-audit.ts` — Ring-2
 * mechanisms that legitimately comment/label/close as scheduled CI jobs,
 * never as an interactive agent-session command check-forge-gates.sh could
 * ever see — producing false G3 STOP conditions on working, documented
 * automation. This narrower reading is the one that matches what "no
 * seventh way into GitHub" (the Ring-0 create/body-edit gate) actually
 * guards.
 *
 * Evaluated PER LINE, not over the whole file: a file legitimately mixing
 * an unrelated `gh pr edit --add-label` (line A) with an unrelated
 * `gh pr comment --body-file` (line B) must never cross-match "edit" from
 * A with "--body" from B into a false create/body-edit finding. Path
 * anchoring for `gh api` mirrors the hook exactly: POST matches the bare
 * collection endpoint (`/issues`, `/pulls`); PATCH requires an exact
 * `/issues/<n>`|`/pulls/<n>` with nothing trailing, so a sub-resource PATCH
 * (`/issues/comments/<id>`) is correctly excluded.
 */
export function isGithubCrossingLine(line: string): boolean {
  const createMatch = /\bgh\s+(pr|issue)\s+create\b/.test(line)
  const editWithBodyOrTitle =
    /\bgh\s+(pr|issue)\s+edit\b/.test(line) &&
    /--body\b|--body-file\b|--title\b|(?:^|\s)-b(?:\s|$)|(?:^|\s)-F(?:\s|$)|(?:^|\s)-t(?:\s|$)/.test(line)
  const apiPost =
    /\bgh\s+api\b/.test(line) &&
    /-X\s*POST\b|--method\s*POST\b|(?:^|\s)-f(?:\s|$)|(?:^|\s)-F(?:\s|$)/.test(line) &&
    /(\/pulls|\/issues)(["'\s]|$)/.test(line)
  const apiPatch =
    /\bgh\s+api\b/.test(line) &&
    /-X\s*PATCH\b|--method\s*PATCH\b/.test(line) &&
    /(\/pulls|\/issues)\/[0-9]+(["'\s]|$)/.test(line)
  const curlWrite =
    /\b(curl|wget)\b/.test(line) &&
    /api\.github\.com/.test(line) &&
    /(\/pulls|\/issues)/.test(line) &&
    /-X\s*(POST|PATCH|PUT)\b|--method\s*(POST|PATCH|PUT)\b|--data\b|(?:^|\s)-d(?:\s|$)|--json\b|--post-data\b/.test(
      line
    )
  return createMatch || editWithBodyOrTitle || apiPost || apiPatch || curlWrite
}

function findCrossingFiles(candidateFiles: string[]): string[] {
  return candidateFiles.filter((path) =>
    readFileSync(join(REPO_ROOT, path), 'utf8')
      .split('\n')
      .some((line) => isGithubCrossingLine(line))
  )
}

// ---------- G4: forge resolution -----------------------------------------------

/**
 * Cheap reachability probe, same pattern `check-first-push-dispatch.ts` uses
 * before trusting any `gh`-shelling script's output: `resolveRepo()` alone
 * can still succeed (e.g. `AEG_REPO` set, or a git remote parses) even when
 * `gh` itself cannot reach a host or resolve credentials — that gap is what
 * silently turned every G4 call into a false "does not resolve" before this
 * fix. Checked once, upfront, before any `gh issue view`/`gh pr view` call.
 */
function ghReachable(): boolean {
  try {
    execSync('gh auth status', { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 8000 })
    return true
  } catch {
    return false
  }
}

/**
 * `repoFlag` (`<owner>/<repo>`) is always resolved and passed explicitly —
 * every call carries `-R <owner>/<repo>` unconditionally (task 23/#360: an
 * untargeted `gh` call from a worktree checkout silently mis-scopes or
 * returns nothing). Callers only construct this after confirming both
 * `resolveRepo()` and `ghReachable()` succeeded (see `main`'s severity:infra
 * escape hatch) — a transient `gh` failure on an individual call still
 * reads as "does not resolve" (the same known, documented limitation
 * `verify-dispatch.ts`'s own `sh()` helper has), but total unreachability
 * no longer silently produces fabricated per-citation findings.
 */
function makeResolveFn(repoFlag: string): (n: number) => boolean {
  const cache = new Map<number, boolean>()
  return (n: number): boolean => {
    if (cache.has(n)) return cache.get(n) ?? false
    const issueOk = sh(`gh issue view ${n} -R ${repoFlag} --json number`) !== ''
    const resolved = issueOk || sh(`gh pr view ${n} -R ${repoFlag} --json number`) !== ''
    cache.set(n, resolved)
    return resolved
  }
}

// ---------- G5: role/contract frontmatter --------------------------------------

type RegistryRoleFrontmatter = { file: string; role_id: string; performs: string[]; refuses_when: string }
type RegistryContractFrontmatter = { file: string; producer: string; consumer: string }

function readRoles(): RegistryRoleFrontmatter[] {
  return readdirSync(join(REPO_ROOT, ROLES_DIR))
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const rel = `${ROLES_DIR}/${name}`
      const { data } = matter(readFileSync(join(REPO_ROOT, rel), 'utf8'))
      return {
        file: rel,
        role_id: typeof data.role_id === 'string' ? data.role_id : '',
        performs: Array.isArray(data.performs) ? data.performs.map(String) : [],
        refuses_when: typeof data.refuses_when === 'string' ? data.refuses_when : ''
      }
    })
}

function readContracts(): RegistryContractFrontmatter[] {
  return readdirSync(join(REPO_ROOT, CONTRACTS_DIR))
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const rel = `${CONTRACTS_DIR}/${name}`
      const { data } = matter(readFileSync(join(REPO_ROOT, rel), 'utf8'))
      return {
        file: rel,
        producer: typeof data.producer === 'string' ? data.producer : '',
        consumer: typeof data.consumer === 'string' ? data.consumer : ''
      }
    })
}

// ---------- output --------------------------------------------------------------

function printResult(result: RegistryCheckResult): void {
  const icon = result.status === 'fail' ? '✗' : result.status === 'info' ? 'ℹ' : '✓'
  console.log(`${icon} ${result.check}: ${result.status} (${result.findings.length} finding(s))`)
  for (const f of result.findings) {
    console.log(`    - ${f.reason}`)
  }
}

/**
 * `--scaffold`: computes the stub-insertion plan, verifies it round-trips
 * (re-parses cleanly, loses no existing row, gains every inserted one)
 * BEFORE writing anything, and only then writes `enforcement.md`. Nothing on
 * disk is ever touched by a plan that fails verification — there is no
 * "restore" step because there is nothing to restore from; the bad rewrite
 * only ever exists in memory. Returns the rows/content to use for the rest
 * of the run (the post-scaffold state when a write happened, the original
 * otherwise), so G1/G2 below report against what's actually on disk now.
 */
function runScaffold(
  enforcementContent: string,
  rows: GateRow[],
  candidateFiles: string[]
): { content: string; rows: GateRow[] } {
  const plan = computeScaffoldPlan(rows, candidateFiles)
  if (plan.stubs.length === 0) {
    console.log('ℹ --scaffold: nothing to insert — every candidate is already documented or has no derivable ring.')
    for (const skip of plan.skipped) console.log(`    - skipped "${skip.path}": ${skip.reason}`)
    return { content: enforcementContent, rows }
  }

  let rewritten: string
  try {
    rewritten = applyScaffoldPlan(enforcementContent, plan)
  } catch (err) {
    console.error(`✗ --scaffold: ${err instanceof Error ? err.message : String(err)} — aborting without writing.`)
    process.exit(1)
  }

  const reparsedRows = parseEnforcementRegistry(rewritten)
  const reparsedImplementations = new Set(reparsedRows.map((r) => r.implementation))
  const originalImplementations = new Set(rows.map((r) => r.implementation).filter((p) => p !== ''))
  const lostExisting = [...originalImplementations].filter((p) => !reparsedImplementations.has(p))
  const missingInserted = plan.stubs.map((s) => s.path).filter((p) => !reparsedImplementations.has(p))

  if (lostExisting.length > 0 || missingInserted.length > 0) {
    console.error('✗ --scaffold: round-trip guard failed — aborting without writing.')
    if (lostExisting.length > 0) console.error(`    existing row(s) lost after rewrite: ${lostExisting.join(', ')}`)
    if (missingInserted.length > 0) {
      console.error(`    inserted stub(s) not found after re-parse: ${missingInserted.join(', ')}`)
    }
    process.exit(1)
  }

  writeFileSync(join(REPO_ROOT, ENFORCEMENT_PATH), rewritten)
  console.log(`✓ --scaffold: inserted ${plan.stubs.length} stub row(s):`)
  for (const stub of plan.stubs) {
    console.log(`    - ${stub.ring} "${stub.checkName ?? stub.path}" (${stub.path})`)
  }
  for (const skip of plan.skipped) console.log(`    - skipped "${skip.path}": ${skip.reason}`)
  return { content: rewritten, rows: reparsedRows }
}

if (import.meta.main) {
  let enforcementContent = readFileSync(join(REPO_ROOT, ENFORCEMENT_PATH), 'utf8')
  let rows: GateRow[] = parseEnforcementRegistry(enforcementContent)

  if (process.argv.includes('--scaffold')) {
    const scaffolded = runScaffold(enforcementContent, rows, globCandidateFiles())
    enforcementContent = scaffolded.content
    rows = scaffolded.rows
  }

  const ring0Rows = rows.filter((r) => r.ring === 'ring0')

  const candidateFiles = globCandidateFiles()
  const crossingFiles = findCrossingFiles(candidateFiles)
  const roles = readRoles()
  const contracts = readContracts()

  // G4 severity:infra escape hatch (mirrors verify-dispatch.ts's runGateMode
  // exactly): resolve the repo and probe `gh` reachability ONCE, up front.
  // Neither failing is a real G4 finding — it means G4 cannot be evaluated
  // at all, not that a citation is fabricated. G1/G2/G3/G5 need no forge
  // access and always run regardless.
  const repo = await resolveRepo()
  const ghOk = repo !== null && ghReachable()

  const g4Result: RegistryCheckResult = ghOk
    ? checkG4(enforcementContent, makeResolveFn(`${repo.owner}/${repo.repo}`))
    : {
        check: 'G4',
        status: 'fail',
        findings: [
          {
            reason:
              "severity:infra — could not resolve a GitHub repo (AEG_REPO / git remote) or `gh` is unreachable (`gh auth status` failed). G4 skipped — cannot evaluate whether enforcement.md's cited forge numbers resolve."
          }
        ]
      }

  const results: RegistryCheckResult[] = [
    checkG1(rows, existsFn),
    checkG2(rows, candidateFiles),
    checkG3(ring0Rows, crossingFiles),
    g4Result,
    checkG5(roles, contracts)
  ]

  for (const result of results) printResult(result)

  console.log(
    'ℹ G6: skipped here — needs coreCheckRegistry(), only importable from apps/cli. Run `vinaya check registry-gates` (or apps/cli/src/checks/bin/check-registry-gates.ts) for the full gate set including G6.'
  )

  const blocking = results.filter(
    (r) =>
      (r.check === 'G1' || r.check === 'G2' || r.check === 'G3' || r.check === 'G4' || r.check === 'G5') &&
      r.status === 'fail'
  )
  process.exit(blocking.length > 0 ? 1 : 0)
}
