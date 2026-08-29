// `vinaya init product <name>` — the `.vinaya/projects.md` registry writer.
//
// Reverses the 2026-07-23 minimal-manifest re-ruling's premise for THIS one
// artifact: that ruling cut the registry row because "no shipped check
// consumes it" (see artifacts.ts's header comment). Vinaya Studio now does —
// its tranche board resolves a project's board route only against a row here
// (`apps/vinaya/web/src/lib/repo-state/read-root.ts`'s `readRegistry()`).
// `init product` writing nothing left that consumer permanently unreachable.
//
// Deliberately NOT modeled as an `Op` (lib/ops.ts) / NOT tracked in the
// `managed` manifest, and so NOT reversed by `eject`. A registry row is the
// adopter's own declared data — "Identity = the registry row... nothing
// more" (the real `.vinaya/projects.md`'s own doctrine) — not vinaya-owned
// scaffolding. `eject` restores the repo to stock Vinaya install state; it
// was never in the business of un-declaring an adopter's projects, the same
// way it does not strip a hand-written `.vinaya/doc-owners` binding.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseRegistry } from '@attalabs/aeg-core'
import type { ProjectEntry } from './config.js'
import { VinayaConfigSchema } from './config.js'

export const PROJECTS_REGISTRY_PATH = '.vinaya/projects.md'
// Duplicated from `artifacts.ts`'s `CONFIG_PATH` rather than imported: that
// module pulls in the doctrine resolver and every artifact emitter, weight
// this file has never carried (same reasoning as this file's own
// `PROJECTS_REGISTRY_PATH` literal, which mirrors `.vinaya/projects.md`
// rather than importing it from anywhere).
const CONFIG_FILE_PATH = 'vinaya.config.json'

export type RegistryRowAction = 'create-host' | 'append-row' | 'skip-present'

export type RegistryRowPlan = {
  action: RegistryRowAction
  /** The row line as it will appear in the table, for diff display. */
  rowLine: string
  /** Repo-relative path, for diff display. */
  path: string
}

function rowLine(name: string, path: string, specsPath: string): string {
  return `| ${name} | \`${path}\` | \`${specsPath}\` | (state tracked globally) |`
}

/** A brand-new `.vinaya/projects.md`, seeded with one row. */
export function freshProjectsRegistry(name: string, path: string, specsPath: string): string {
  return `---
sidebar_title: Projects
---
# Projects in this repo

**The project registry.** Declares the projects in this repo and where each
one's specs and per-project state live. The \`Project\` field on a task (a
forge Issue) resolves against this file.

**Presence of this file means this is a multi-project repo** — the
\`Project\` field is required on task Issues/PRs that touch a registered
project's path. A project is a \`(name, path)\` pair you declared — nothing
is derived from the folder tree.

## Registry

| Project | Path | Specs | Per-project state |
|---------|------|-------|---------------------|
${rowLine(name, path, specsPath)}
`
}

const REGISTRY_HEADING_RE = /^##\s+Registry\b/i

/**
 * Insert a new row immediately after the last existing row of the `##
 * Registry` table. Falls back to appending a fresh `## Registry` section at
 * the end of the file if the heading isn't found (a foreign/hand-authored
 * file that doesn't follow the expected shape) — never throws, never drops
 * existing content.
 */
export function appendRegistryRow(content: string, name: string, path: string, specsPath: string): string {
  const lines = content.split(/\r?\n/)
  const headingIdx = lines.findIndex((l) => REGISTRY_HEADING_RE.test(l))
  const newRow = rowLine(name, path, specsPath)

  if (headingIdx === -1) {
    const sep = content.endsWith('\n') ? '' : '\n'
    return `${content}${sep}\n## Registry\n\n| Project | Path | Specs | Per-project state |\n|---------|------|-------|---------------------|\n${newRow}\n`
  }

  let i = headingIdx + 1
  for (; i < lines.length; i++) {
    if ((lines[i] ?? '').trim().startsWith('|')) break
  }
  if (i >= lines.length) {
    // Heading present but no table under it — append one.
    lines.splice(
      headingIdx + 1,
      0,
      '',
      '| Project | Path | Specs | Per-project state |',
      '|---------|------|-------|---------------------|',
      newRow
    )
    return lines.join('\n')
  }
  // Skip header + separator rows, then walk the existing body rows.
  let last = i + 1
  for (let j = i + 2; j < lines.length; j++) {
    if (!(lines[j] ?? '').trim().startsWith('|')) break
    last = j
  }
  lines.splice(last + 1, 0, newRow)
  return lines.join('\n')
}

/** Classify what `init product <name>` would do to the registry — no writes. */
export function planRegistryRow(repoRoot: string, name: string, path: string, specsPath: string): RegistryRowPlan {
  const abs = join(repoRoot, PROJECTS_REGISTRY_PATH)
  const line = rowLine(name, path, specsPath)
  if (!existsSync(abs)) {
    return { action: 'create-host', rowLine: line, path: PROJECTS_REGISTRY_PATH }
  }
  const existing = readFileSync(abs, 'utf-8')
  const already = parseRegistry(existing).some((p) => p.name === name)
  return { action: already ? 'skip-present' : 'append-row', rowLine: line, path: PROJECTS_REGISTRY_PATH }
}

/** Apply a previously-planned registry-row change. No-op for `skip-present`. */
export function applyRegistryRow(
  repoRoot: string,
  plan: RegistryRowPlan,
  name: string,
  path: string,
  specsPath: string
): void {
  const abs = join(repoRoot, PROJECTS_REGISTRY_PATH)
  if (plan.action === 'create-host') {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, freshProjectsRegistry(name, path, specsPath), 'utf-8')
  } else if (plan.action === 'append-row') {
    const existing = readFileSync(abs, 'utf-8')
    writeFileSync(abs, appendRegistryRow(existing, name, path, specsPath), 'utf-8')
  }
}

export function renderRegistryRowDiffLine(plan: RegistryRowPlan): string {
  if (plan.action === 'skip-present') return `  = keep   ${plan.path} (project already registered)`
  if (plan.action === 'append-row') return `  ~ append row to ${plan.path}\n    ${plan.rowLine}`
  return `  + create ${plan.path} (with registry row)\n    ${plan.rowLine}`
}

// ---------------------------------------------------------------------------
// The config-native sibling write path — same plan/apply/render discipline,
// targeting `vinaya.config.json`'s `projects` array instead of the registry
// markdown table. `init product` calls both; they are independent homes for
// the same declared fact (see `config.ts`'s `ProjectEntrySchema` comment).
// ---------------------------------------------------------------------------

export type ConfigProjectEntryAction = 'add-entry' | 'skip-present'
export type ConfigProjectEntryPlan = { action: ConfigProjectEntryAction; entry: ProjectEntry }

/** Best-effort parse: an unreadable/invalid config here is `init product`'s own pre-flight failure elsewhere — this never throws, it just sees no existing entries. */
function readProjectEntries(repoRoot: string): ProjectEntry[] {
  const abs = join(repoRoot, CONFIG_FILE_PATH)
  if (!existsSync(abs)) return []
  try {
    return VinayaConfigSchema.parse(JSON.parse(readFileSync(abs, 'utf-8'))).projects ?? []
  } catch {
    return []
  }
}

/** Classify what `init product <name>` would do to `vinaya.config.json`'s `projects` array — no writes. Dedup key is `name`, mirroring `planRegistryRow`'s own `parseRegistry(...).some((p) => p.name === name)` check. */
export function planConfigProjectEntry(repoRoot: string, entry: ProjectEntry): ConfigProjectEntryPlan {
  const already = readProjectEntries(repoRoot).some((p) => p.name === entry.name)
  return { action: already ? 'skip-present' : 'add-entry', entry }
}

/** Apply a previously-planned config-project-entry change. No-op for `skip-present`. */
export function applyConfigProjectEntry(repoRoot: string, plan: ConfigProjectEntryPlan): void {
  if (plan.action === 'skip-present') return
  const abs = join(repoRoot, CONFIG_FILE_PATH)
  const seed = JSON.parse(readFileSync(abs, 'utf-8'))
  const projects = Array.isArray(seed.projects) ? seed.projects : []
  writeFileSync(abs, `${JSON.stringify({ ...seed, projects: [...projects, plan.entry] }, null, 2)}\n`, 'utf-8')
}

export function renderConfigProjectEntryDiffLine(plan: ConfigProjectEntryPlan): string {
  if (plan.action === 'skip-present')
    return `  = keep   ${CONFIG_FILE_PATH} (project already declared under "projects")`
  const bits = [`"name": ${JSON.stringify(plan.entry.name)}`]
  if (plan.entry.path) bits.push(`"path": ${JSON.stringify(plan.entry.path)}`)
  if (plan.entry.description) bits.push(`"description": ${JSON.stringify(plan.entry.description)}`)
  return `  ~ append entry to ${CONFIG_FILE_PATH}'s "projects"\n    { ${bits.join(', ')} }`
}
