#!/usr/bin/env bun

/**
 * Core check: registry-gates. Thin adapter over `@attalabs/aeg-core`'s
 * `checkG1`–`checkG5` — mirrors `packages/aeg-core/bin/verify-registry.ts`'s
 * input assembly (`aeg-root/enforcement.md` parse, `.husky`/`.claude/hooks`
 * candidate-file glob, role/contract frontmatter, G4's `gh`-reachability
 * probe), collapsed into ONE registered check rather than five, emitting
 * the check contract instead of human text.
 *
 * DIVERGES from `verify-registry.ts`'s own glob on one point (Issue #232):
 * that standalone tool also globs `packages/aeg-core/bin` as a `G2`
 * candidate-file location.
 * `packages/aeg-core` is this monorepo's own package layout, not a fact any
 * shipped, adopter-facing check may assume — `verify-registry.ts` never
 * ships to an adopter (it is an internal-only tool this monorepo runs on
 * itself), so it keeps that probe; this shipped adapter drops it instead of
 * carrying a repo-specific path into every `vinaya init` install.
 *
 * Collapsed, not six separate `CheckSpec`s (Developer's call, per Issue
 * #760 §4): G1–G6 share nearly all their I/O (the same `enforcement.md`
 * parse, the same candidate-file glob, the same `gh`-reachability probe) —
 * six near-identical thin scripts would each redo that work. Each finding
 * still names its own G-number in BOTH `CheckError.check` (`registry-gates.G3`,
 * not just `registry-gates`) and `CheckError.message` — the hard constraint
 * from Issue #760's own Traps-to-avoid (a Developer merging distinct
 * failure classes into one undifferentiated report is a regression, not a
 * simplification) is met by that per-finding tagging, not by the CheckSpec
 * count.
 *
 * G6 (task 8, Issue #57) is the one G-check that genuinely needs to live
 * here rather than in `aeg-core`'s standalone `verify-registry.ts`: it
 * validates a doctrine row's `product`-audience claim against
 * `coreCheckRegistry()`, which only this package can import without closing
 * a dependency cycle — same reasoning `gate-audience.ts` documents for
 * `GATE_AUDIENCE` itself.
 *
 * DORMANT WHEN ABSENT, EXPLICITLY (Issue #232 — same discipline
 * `evaluateC5`/`.vinaya/doc-owners` already uses): G1–G6 validate
 * `aeg-root/enforcement.md` against THIS monorepo's
 * own `aeg-root/roles/`/`aeg-root/contracts/` doctrine-authoring tree — a
 * fact about how AEG's own doctrine is developed, not something any
 * `vinaya init` install ever produces (settled by experiment: a fresh
 * `npm i @attalabs/vinaya` + `vinaya init --yes` repo carries no
 * `aeg-root/` at all — the doctrine ships read-only inside
 * `node_modules/@attalabs/vinaya/aeg-root`). Redirecting to that installed
 * copy would not fix this: G4 resolves the enforcement rows' own cited
 * issue/PR numbers against the CALLING repo's git remote
 * (`resolveRepo()`), so pointing G1–G6 at the package's copy while still
 * resolving against the adopter's own remote would assert facts about the
 * wrong repository entirely. This check means the author repo's own tree,
 * full stop — there is no adopter-facing form of it. Before this task, an
 * absent `aeg-root/enforcement.md` made this adapter `exit(0)` with zero
 * findings — indistinguishable, in `vinaya check --all`'s own output, from
 * a real pass that inspected a real doctrine tree (confirmed: a fresh
 * adopter fixture reported `registry-gates: pass` while `aeg-root/` did
 * not exist to inspect). It now instead emits one `warning`-severity
 * finding announcing the dormancy and its reason before exiting 0 — the
 * `check-reader-resolvable-prose` shape (an announced no-op), applied here
 * for the first time. `--all`'s own renderer already prints every finding
 * under its check's summary line regardless of exit code
 * (`commands/check.ts`), so the dormancy notice is visible in the same
 * transcript a silent `pass` used to hide it from.
 *
 * scope: full — reads the whole doctrine tree, not the local diff.
 */

import { execSync, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import matter from 'gray-matter'
import {
  checkG1,
  checkG2,
  checkG3,
  checkG4,
  checkG5,
  checkG6,
  parseEnforcementRegistry,
  type RegistryCheckResult
} from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { coreCheckRegistry } from '../registry.js'

const CHECK_NAME = 'registry-gates'
const ENFORCEMENT_PATH = 'aeg-root/enforcement.md'
const ROLES_DIR = 'aeg-root/roles'
const CONTRACTS_DIR = 'aeg-root/contracts'

function isGithubCrossingLine(line: string): boolean {
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

function globCandidateFiles(): string[] {
  const out: string[] = []
  if (existsSync('.husky')) {
    for (const name of readdirSync('.husky')) {
      if (name === '_') continue
      const rel = `.husky/${name}`
      if (statSync(rel).isFile()) out.push(rel)
    }
  }
  if (existsSync('.claude/hooks')) {
    for (const name of readdirSync('.claude/hooks')) {
      if (name.endsWith('.sh')) out.push(`.claude/hooks/${name}`)
    }
  }
  return out
}

function findCrossingFiles(candidateFiles: string[]): string[] {
  return candidateFiles.filter((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .some((line) => isGithubCrossingLine(line))
  )
}

type GatesRoleFrontmatter = { file: string; role_id: string; performs: string[]; refuses_when: string }
type GatesContractFrontmatter = { file: string; producer: string; consumer: string }

function readRoles(): GatesRoleFrontmatter[] {
  if (!existsSync(ROLES_DIR)) return []
  return readdirSync(ROLES_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const rel = `${ROLES_DIR}/${name}`
      const { data } = matter(readFileSync(rel, 'utf8'))
      return {
        file: rel,
        role_id: typeof data.role_id === 'string' ? data.role_id : '',
        performs: Array.isArray(data.performs) ? data.performs.map(String) : [],
        refuses_when: typeof data.refuses_when === 'string' ? data.refuses_when : ''
      }
    })
}

function readContracts(): GatesContractFrontmatter[] {
  if (!existsSync(CONTRACTS_DIR)) return []
  return readdirSync(CONTRACTS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const rel = `${CONTRACTS_DIR}/${name}`
      const { data } = matter(readFileSync(rel, 'utf8'))
      return {
        file: rel,
        producer: typeof data.producer === 'string' ? data.producer : '',
        consumer: typeof data.consumer === 'string' ? data.consumer : ''
      }
    })
}

function ghReachable(): boolean {
  try {
    execSync('gh auth status', { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 8000 })
    return true
  } catch {
    return false
  }
}

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

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

function resolveRepo(): { owner: string; repo: string } | null {
  const fromEnv = process.env.AEG_REPO
  if (fromEnv) {
    const m = fromEnv.match(/^([^/]+)\/(.+)$/)
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] }
  }
  let url: string
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] }
  const https = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] }
  return null
}

function emitResult(result: RegistryCheckResult, blocking: boolean): void {
  for (const f of result.findings) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: `${CHECK_NAME}.${result.check}`,
      severity: blocking ? 'error' : 'warning',
      message: `${result.check}: ${f.reason}`,
      agent_recovery_prompt: `Read the ${result.check} finding above (enforcement.md row / candidate file / role-contract frontmatter) and fix the drift it names, then re-run \`vinaya check registry-gates\`.`,
      ...(f.path ? { file: f.path } : {})
    })
  }
}

async function main(): Promise<void> {
  if (!existsSync(ENFORCEMENT_PATH)) {
    // Dormant, EXPLICITLY — see module doc's "DORMANT WHEN ABSENT,
    // EXPLICITLY". A warning finding, not a silent exit: `--all` prints
    // findings under their check's summary line regardless of exit code,
    // so this is visible in the same transcript a bare `exit(0)` hid it
    // from.
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: `${CHECK_NAME}.dormant`,
      severity: 'warning',
      message: `${CHECK_NAME}: dormant — no ${ENFORCEMENT_PATH} in this repository. This check validates the AEG doctrine-authoring tree's own internal coherence (enforcement rows against role/contract frontmatter); it has no adopter-facing form and does not run outside the repo that authors that doctrine.`,
      agent_recovery_prompt:
        'No action needed — this check only applies inside the repository that authors the AEG doctrine tree (aeg-root/roles, aeg-root/contracts, aeg-root/enforcement.md). An adopter repo installing @attalabs/vinaya never carries that tree and is not expected to.'
    })
    process.exit(0)
  }

  const enforcementContent = readFileSync(ENFORCEMENT_PATH, 'utf8')
  const rows = parseEnforcementRegistry(enforcementContent)
  const ring0Rows = rows.filter((r) => r.ring === 'ring0')

  const candidateFiles = globCandidateFiles()
  const crossingFiles = findCrossingFiles(candidateFiles)
  const roles = readRoles()
  const contracts = readContracts()

  const repo = resolveRepo()
  const ghOk = repo !== null && ghReachable()

  const g4Result: RegistryCheckResult = ghOk
    ? checkG4(
        enforcementContent,
        makeResolveFn(
          `${(repo as { owner: string; repo: string }).owner}/${(repo as { owner: string; repo: string }).repo}`
        )
      )
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

  const g1 = checkG1(rows, existsSync)
  const g2 = checkG2(rows, candidateFiles)
  const g3 = checkG3(ring0Rows, crossingFiles)
  const g5 = checkG5(roles, contracts)
  const g6 = checkG6(rows, new Set(coreCheckRegistry().map((s) => s.name)))

  // G1 and G2 (both re-graded blocking in plan-brief-v1 task 8) and
  // G3/G4/G5/G6: blocking.
  emitResult(g1, true)
  emitResult(g2, true)
  emitResult(g3, true)
  emitResult(g4Result, true)
  emitResult(g5, true)
  emitResult(g6, true)

  const blockingFailed = [g1, g2, g3, g4Result, g5, g6].some((r) => r.status === 'fail')
  process.exit(blockingFailed ? 1 : 0)
}

main()
