/**
 * `vinaya task sweep [--include-legacy] [--json]` — argv parsing and
 * rendering only. `lib/task-sweep.js`'s `runTaskSweep` is the entire reader
 * and writer; this file calls it exactly once (`apps/cli/specs/surface.md`).
 */

import { printJson } from '../lib/envelope.js'
import { runTaskSweep } from '../lib/task-sweep.js'

function parseArgs(args: string[]): { includeLegacy: boolean; json: boolean } {
  let includeLegacy = false
  let json = false
  for (const a of args) {
    if (a === '--include-legacy') includeLegacy = true
    else if (a === '--json') json = true
    else {
      console.error(`vinaya task sweep: unrecognized argument \`${a}\` (expected --include-legacy, --json)`)
      process.exit(2)
    }
  }
  return { includeLegacy, json }
}

export async function taskSweepCommand(args: string[]): Promise<void> {
  const { includeLegacy, json } = parseArgs(args)
  const result = runTaskSweep({ includeLegacy })

  if (json) {
    printJson(result)
    return
  }

  for (const entry of result.modern.removed) {
    process.stdout.write(`removed ${entry.folder} — ${entry.reason}\n`)
  }
  for (const entry of result.modern.kept) {
    process.stdout.write(`kept ${entry.folder} — ${entry.reason}\n`)
  }

  for (const entry of result.legacy.entries) {
    const belongsTo =
      entry.attribution.kind === 'unattributable'
        ? `unattributable — ${entry.attribution.reason}`
        : entry.attribution.kind === 'other-repo'
          ? 'belongs to a different repository'
          : entry.class
            ? `this repository — ${entry.class.kind} — ${entry.class.reason}`
            : 'this repository'
    const action = entry.removed ? 'removed' : 'kept'
    process.stdout.write(`legacy [${entry.dirname}] ${action} ${entry.path} — ${belongsTo}\n`)
  }

  if (!includeLegacy && result.legacy.entries.some((e) => e.attribution.kind === 'this-repo')) {
    process.stdout.write('Re-run with --include-legacy to remove what the above attributes to a finished task.\n')
  }
}

import type { SurfaceExemption } from '../lib/surface-exemption.js'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'task sweep': { date: '2026-09-21', callsToday: 2, retiresVia: 'sharedCommandShell' }
}
