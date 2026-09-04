/**
 * `vinaya brief render <tranche> <n> --surfaces <glob,...>` (task 12, #387)
 * — the forge/tree shim over `@attalabs/aeg-core`'s pure
 * `renderBrief`. Never writes under `aeg-root/` or to the Issue: stdout, or
 * `--out <path>`, only — a brief is pasted to the Developer, never committed.
 *
 * Dispatch-gate assembly mirrors `checks/bin/check-dispatch-readiness.ts`
 * (same `resolveEdge`/`fetchForgeFacts`/`checkDispatchReadiness` composition)
 * rather than a fourth copy of that logic — `edge-resolve.ts`'s own doc
 * comment already records three such copies disagreeing before consolidation.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildConsumersOf,
  checkDispatchReadiness,
  checkIssueRationale,
  fetchForgeFacts,
  fetchOpenIssuesByLabel,
  parseObjectives,
  parseRationaleFields,
  type PackageManifest,
  renderBrief,
  type BriefFacts,
  type DispatchConflictsWithFact,
  type DispatchDependsOnFact,
  type DispatchGateInput,
  type DispatchPriorTrancheFact,
  type SurfaceFileFact
} from '@attalabs/aeg-core'
import { createForgeSource } from '@attalabs/vinaya-sources'
import { resolveEdge } from '../checks/edge-resolve.js'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../lib/config.js'

const DOC_OWNERS_PATH = '.vinaya/doc-owners'
const TEMPLATE_PATH = 'aeg-root/templates/brief-template.md'

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/** Same shape `checks/bin/check-dispatch-readiness.ts` uses — kept local rather than a fourth copy of `resolveEdge`'s own two prior consolidations. */
function resolveRepo(): { owner: string; repo: string } | null {
  const fromEnv = process.env.AEG_REPO
  if (fromEnv) {
    const m = fromEnv.match(/^([^/]+)\/(.+)$/)
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] }
  }
  const url = git(['remote', 'get-url', 'origin'])
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] }
  const https = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] }
  return null
}

async function resolveToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  try {
    return (
      execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
    )
  } catch {
    return null
  }
}

function refuse(message: string): never {
  console.error(`vinaya brief render: refused — ${message}`)
  process.exit(1)
}

/** `git ls-files -- <glob>`, one call per glob so an empty result names ITS OWN glob, not the whole batch. */
export function expandGlob(glob: string): string[] {
  const out = git(['ls-files', '--', glob])
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function readManifest(dir: string): PackageManifest | null {
  const manifest = readJson(join(dir, 'package.json'))
  return Object.keys(manifest).length === 0 ? null : (manifest as PackageManifest)
}

/** `apps/cli`/`packages/aeg-core` → that workspace member's own `package.json` `name` field, or `null` outside any workspace member — never a directory path, per `SurfaceFileFact.packageName`'s own contract. */
export function packageNameForPath(path: string): string | null {
  const m = /^((?:packages|apps)\/[^/]+)\//.exec(path)
  if (!m) return null
  const manifest = readJson(join(m[1] as string, 'package.json'))
  return typeof manifest.name === 'string' ? manifest.name : null
}

function workspaceGlobs(): string[] {
  const root = readJson('package.json')
  return Array.isArray(root.workspaces) ? (root.workspaces as string[]) : []
}

export async function briefRenderCommand(args: string[]): Promise<void> {
  const trancheSlug = args[0]
  const taskId = args[1]
  if (!trancheSlug || !taskId || trancheSlug.startsWith('--')) {
    console.error('Usage: vinaya brief render <tranche> <n> --surfaces <glob1,glob2,...> [--out <path>]')
    process.exit(2)
  }

  const surfacesIdx = args.indexOf('--surfaces')
  const surfacesArg = surfacesIdx !== -1 ? args[surfacesIdx + 1] : undefined
  if (!surfacesArg) refuse('--surfaces <glob1,glob2,...> is required.')
  const globs = (surfacesArg as string)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (globs.length === 0) refuse('--surfaces resolved to zero globs.')

  const outIdx = args.indexOf('--out')
  const outPath = outIdx !== -1 ? args[outIdx + 1] : undefined

  const repo = resolveRepo()
  if (!repo) refuse('could not resolve owner/repo (set AEG_REPO=owner/repo, or confirm `git remote get-url origin`).')

  const source = createForgeSource({ owner: repo.owner, repo: repo.repo })
  const tranche = await source.getTranche(trancheSlug).catch((err: unknown) => {
    refuse(
      `could not derive tranche "${trancheSlug}" from the forge: ${err instanceof Error ? err.message : String(err)}`
    )
  })
  const task = tranche.tasks.find((t) => t.id === taskId)
  if (!task) refuse(`task "${taskId}" is not present in tranche "${trancheSlug}"'s forge-derived task list.`)

  const token = (await resolveToken()) ?? ''
  const openIssuesBySlug = await fetchOpenIssuesByLabel([trancheSlug], repo.owner, repo.repo, token)
  const openIssues = openIssuesBySlug.get(trancheSlug) ?? []
  const openIssueMatch = task.issue !== null ? openIssues.find((i) => i.number === task.issue) : undefined

  if (task.issue === null) refuse(`task "${taskId}" has no Issue (#TBD or blank) — not renderable until one is cut.`)
  if (!openIssueMatch) {
    refuse(
      `Issue #${task.issue} for task "${taskId}" could not be read (closed, or not labeled \`vinaya/tranche:${trancheSlug}\`) — a brief renders only from an open, labeled task Issue.`
    )
  }
  const issueBody = openIssueMatch.body
  const issueRationalePass = checkIssueRationale(issueBody).status !== 'fail'

  const taskRefs = tranche.tasks.map((t) => ({ id: t.id, issue: t.issue }))
  const snapshot = await fetchForgeFacts({ owner: repo.owner, repo: repo.repo, tranche: trancheSlug, tasks: taskRefs })
  const taskById = new Map(tranche.tasks.map((t) => [t.id, t]))

  const dependsOn: DispatchDependsOnFact[] = await Promise.all(
    task.dependsOn.map(async (dep) => {
      const r = await resolveEdge(dep, taskById, snapshot.facts, repo)
      return {
        id: dep,
        issue: r.issue,
        merged: r.merged,
        resolved: r.resolved,
        issueState: r.issueState,
        stateReason: r.stateReason,
        closedByActor: r.closedByActor
      }
    })
  )
  const conflictsWith: DispatchConflictsWithFact[] = await Promise.all(
    task.conflictsWith.map(async (c) => {
      const r = await resolveEdge(c, taskById, snapshot.facts, repo)
      return { id: c, issue: r.issue, openOrInFlight: r.open }
    })
  )
  const priorTrancheArchival: DispatchPriorTrancheFact[] = []

  const gateInput: DispatchGateInput = {
    trancheSlug,
    task,
    issue: { number: task.issue, state: 'open' },
    issueRationalePass,
    dependsOn,
    conflictsWith,
    priorTask: null,
    priorTrancheArchival,
    principalAllowlist: resolvePrincipalAllowlist(loadTrustAnchorConfig())
  }
  const gate = checkDispatchReadiness(gateInput)

  const surfaceFiles: SurfaceFileFact[] = []
  for (const glob of globs) {
    const matches = expandGlob(glob)
    if (matches.length === 0) refuse(`--surfaces glob "${glob}" matched no tracked file.`)
    for (const path of matches) {
      surfaceFiles.push({ path, sha256: sha256OfFile(path), packageName: packageNameForPath(path) })
    }
  }

  const workspaces = workspaceGlobs()
  const consumersOf = buildConsumersOf(workspaces, listDirs, readManifest)

  const facts: BriefFacts = {
    trancheSlug,
    taskId,
    title: task.title,
    issue: task.issue,
    projects: task.projects,
    dependsOn: task.dependsOn,
    conflictsWith: task.conflictsWith,
    rationale: parseRationaleFields(issueBody),
    objectives: (() => {
      const parsed = parseObjectives(issueBody)
      return parsed.ok ? parsed.objectives : []
    })(),
    dispatchReady: gate.ready,
    dispatchBlockers: gate.blockers,
    surfaceFiles,
    consumersOf,
    docOwnersContent: existsSync(DOC_OWNERS_PATH) ? readFileSync(DOC_OWNERS_PATH, 'utf8') : null
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf8')
  const result = renderBrief(facts, template)
  if (!result.ok) {
    refuse(`cannot render — missing fact(s):\n${result.missing.map((m) => `  - ${m}`).join('\n')}`)
  }

  if (outPath) {
    writeFileSync(outPath, result.brief.endsWith('\n') ? result.brief : `${result.brief}\n`)
    process.stdout.write(`Wrote brief to ${outPath}\n`)
  } else {
    process.stdout.write(`${result.brief}\n`)
  }
}
