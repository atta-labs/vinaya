/**
 * Where a draft lives: one file per tranche slug, on this machine, under the
 * run folder in a plan scope of its own (`harness/kernel/run-paths.ts`) — never
 * in the repository and never on the forge. A draft and its review rounds
 * survive a new chat on the same machine and do not follow anyone to another.
 *
 * Writing a slug that already has a draft replaces it, whole and atomically: a
 * reader sees the old draft or the new one, never a mix.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { ensureRunDir, runPath } from '@harness/kernel/run-paths'
import { type PlanDraft, parsePlanDraft } from './draft'

const DRAFT_FILE = 'draft.json'

/** The one file holding the draft of `tranche`. */
export function draftFilePath(runtimeDir: string, tranche: string): string {
  return runPath(runtimeDir, { plan: tranche }, { area: 'task', file: DRAFT_FILE })
}

/** The stored form: keys in a fixed order at every level, two-space indent, one trailing newline. */
function storedForm(draft: PlanDraft): string {
  const ordered = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(ordered)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, ordered(x)])
      )
    }
    return v
  }
  return `${JSON.stringify(ordered(draft), null, 2)}\n`
}

/** Stores `draft`, replacing any draft of the same tranche. Returns the file written. */
export function writePlanDraft(runtimeDir: string, draft: PlanDraft): string {
  const file = draftFilePath(runtimeDir, draft.tranche)
  ensureRunDir(runPath(runtimeDir, { plan: draft.tranche }, { area: 'task' }), runtimeDir)
  const staging = `${file}.${process.pid}.tmp`
  writeFileSync(staging, storedForm(draft), { encoding: 'utf8', mode: 0o600 })
  renameSync(staging, file)
  return file
}

/** The stored draft of `tranche`, or `null` when none exists or the stored file is not a valid draft. */
export function readPlanDraft(runtimeDir: string, tranche: string): PlanDraft | null {
  let text: string
  try {
    text = readFileSync(draftFilePath(runtimeDir, tranche), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = parsePlanDraft(JSON.parse(text))
    return parsed.ok ? parsed.draft : null
  } catch {
    return null
  }
}
