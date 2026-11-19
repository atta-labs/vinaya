import { readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { ATTRIBUTE_NAMES as A } from '../contract/catalogue.js'
import { narrate } from '../narration/narrate.js'
import { createFolderSource } from '../reader/folder-source.js'
import { createReader, type Reader } from '../reader/source.js'
import { repoSegment, type ResolvedSettings } from '../writer/settings.js'

async function physical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    return join(await physical(parent), relative(parent, path))
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}

export async function localFolder(settings: ResolvedSettings, root: string, repository?: string): Promise<string> {
  const configured = (settings.logs || undefined)?.folder
  const folder =
    configured && !inside(root, configured) && !inside(await physical(root), await physical(configured))
      ? configured
      : join(settings.runtimeDir, 'logs')
  const target = join(await physical(folder), repoSegment(repository))
  if ((await physical(target)) !== target || inside(await physical(root), target)) {
    throw new Error('Unsafe local Log directory')
  }
  return target
}

async function listRuns(folder: string): Promise<Set<string>> {
  const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const runs = new Set<string>()
  for (const name of names) {
    const run = /^([^~]+)~[^~]+~\d{12}\.(?:logs|traces)\.jsonl$/.exec(name)?.[1]
    if (run !== undefined) runs.add(run)
  }
  return runs
}

function terminalLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
}

function runReader(folder: string, runId: string): Reader {
  return createReader(createFolderSource({ folder, runId, canonicalFolder: true }), { firstSequence: 1 })
}

export async function follow(folder: string, selection: { run?: string; task?: string }): Promise<void> {
  const readers = new Map<string, Reader>()
  const matched = new Set<string>()
  for (;;) {
    const runs = selection.run === undefined ? await listRuns(folder) : [selection.run]
    for (const runId of runs) {
      // SDK writers count from one. File-level gaps still come from the source.
      if (!readers.has(runId)) readers.set(runId, runReader(folder, runId))
    }
    for (const [runId, reader] of readers) {
      let update = await reader.pull()
      if (selection.task !== undefined && !matched.has(runId)) {
        if (!update.records.some((record) => record.attributes[A.workRef] === selection.task)) continue
        matched.add(runId)
        const replay = runReader(folder, runId)
        readers.set(runId, replay)
        update = await replay.pull()
      }
      const { records, gaps } = update
      for (const record of records) {
        console.log(terminalLine(narrate(record)?.text ?? record.name))
      }
      for (const gap of gaps) console.log('Log gap in %s: %s', terminalLine(runId), terminalLine(gap.detail))
    }
    await setTimeout(250)
  }
}
