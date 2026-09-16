/**
 * `vinaya brief render <tranche> <n> --surfaces <glob,...>`
 * — argv parsing around `../lib/brief-assembly.js`'s `assembleAndRenderBrief`,
 * the forge/tree shim over `@attalabs/aeg-core`'s pure `renderBrief`. Never
 * writes under `aeg-root/` or to the Issue: stdout, or `--out <path>`, only —
 * a brief is pasted to the Developer, never committed.
 *
 * The assembly itself was extracted out of this file so `dispatchTask`
 * (`lib/dispatch-task.ts`) can render the identical brief for
 * `vinaya task dispatch` without a second copy of it — this file
 * now supplies only the `--surfaces`/`--out` argv handling `assembleAndRenderBrief`
 * itself has no operator present to provide.
 */

import { writeFileSync } from 'node:fs'
import { assembleAndRenderBrief } from '../lib/brief-assembly.js'

export { expandGlob, packageNameForPath, sha256OfFile } from '../lib/brief-assembly.js'

function refuse(message: string): never {
  console.error(`vinaya brief render: refused — ${message}`)
  process.exit(1)
}

export async function briefRenderCommand(args: string[]): Promise<void> {
  const trancheSlug = args[0]
  const taskId = args[1]
  if (!trancheSlug || !taskId || trancheSlug.startsWith('--')) {
    console.error('Usage: vinaya brief render <tranche> <n> [--surfaces <glob1,glob2,...>] [--out <path>]')
    process.exit(2)
  }

  // `--surfaces` is an override, not a requirement:
  // omitted, `assembleAndRenderBrief` derives the surface from the Issue's
  // own `## Surface` section — the same source `vinaya task dispatch`
  // already reads — so the two entry points can never render a brief from
  // different surfaces, and nobody has to retype globs the Issue already
  // declares.
  const surfacesIdx = args.indexOf('--surfaces')
  const surfacesArg = surfacesIdx !== -1 ? args[surfacesIdx + 1] : undefined
  let globs: string[] | undefined
  if (surfacesIdx !== -1) {
    if (!surfacesArg) refuse('--surfaces <glob1,glob2,...> was passed with no value.')
    globs = (surfacesArg as string)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (globs.length === 0) refuse('--surfaces resolved to zero globs.')
  }

  const outIdx = args.indexOf('--out')
  const outPath = outIdx !== -1 ? args[outIdx + 1] : undefined

  const result = await assembleAndRenderBrief(trancheSlug, taskId, globs)
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
