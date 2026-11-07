import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROGRAMS } from '../../../harness/processes/vinaya-strict/tools/programs.js'

// The command line's allow list: `ownership.json` classifies every tracked file under `apps/cli` by what it is,
// and names every route the router dispatches as a command a person types or a Planner's or Architect's command.
// A file, a route or a manifest `bin` that arrives without a place here fails.

const CLI = join(import.meta.dir, '..')
type Ownership = { routes: Record<string, string[]>; files: Record<string, string[]> }
const ownership = JSON.parse(readFileSync(join(CLI, 'ownership.json'), 'utf8')) as Ownership

/** The classes whose entry covers `path` (relative to `apps/cli`): an exact path, or a folder ending in `/`. */
function classesOf(path: string, files: Record<string, string[]> = ownership.files): string[] {
  return Object.entries(files)
    .filter(([, entries]) => entries.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry)))
    .map(([name]) => name)
}

/** Every route the router reaches: each `case` label, and `<label> <sub>` for each sub-command literal in its block. */
export function routes(source: string): string[] {
  const names = ['help']
  for (const match of source.matchAll(/case '([a-z-]+)':([\s\S]*?)(?=\n\s*case '|\n\s*default:)/g)) {
    const label = match[1] as string
    const block = match[2] as string
    const subcommands = [...block.matchAll(/subcommand === '([a-z][a-z -]*)'/g)].map((m) => m[1] as string)
    if (subcommands.length === 0 || !/console\.error\(\s*`Unknown/.test(block)) names.push(label)
    for (const sub of subcommands) names.push(`${label} ${sub}`)
  }
  return names
}

const tracked = execFileSync('git', ['ls-files', '--', '.'], { cwd: CLI, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)

describe('the command line allow list', () => {
  test('classifies every tracked file under apps/cli exactly once', () => {
    expect(tracked.length).toBeGreaterThan(0)
    const unclassified = tracked.filter((path) => classesOf(path).length === 0)
    const twice = tracked.filter((path) => classesOf(path).length > 1)
    expect({ unclassified, twice }).toEqual({ unclassified: [], twice: [] })
  })

  test('an unclassified file fails', () => {
    expect(classesOf('src/commands/a-plumbing-command.ts')).toEqual([])
  })

  test('lists every route the router dispatches as a command class, and nothing the router does not dispatch', () => {
    const routed = routes(readFileSync(join(CLI, 'src', 'index.ts'), 'utf8'))
    const listed = Object.values(ownership.routes).flat()
    expect({
      unlisted: routed.filter((r) => !listed.includes(r)),
      stale: listed.filter((r) => !routed.includes(r))
    }).toEqual({
      unlisted: [],
      stale: []
    })
  })

  test('a route the inventory does not list fails', () => {
    const routed = routes("switch (command) {\n    case 'check': {\n      break\n    }\n    default:\n")
    expect(routed.filter((r) => !Object.values(ownership.routes).flat().includes(r))).toEqual(['check'])
  })

  test('the manifest bin map is vinaya plus exactly the program table, each at its built file', () => {
    const manifest = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')) as { bin: Record<string, string> }
    const expected: Record<string, string> = { vinaya: 'dist/index.js' }
    for (const program of PROGRAMS.values()) expected[program.bin] = program.built
    expect(manifest.bin).toEqual(expected)
  })

  test('a manifest bin the program table does not name fails', () => {
    const tableBins = new Set([...PROGRAMS.values()].map((program) => program.bin))
    expect(['vinaya-not-a-program'].filter((bin) => !tableBins.has(bin))).toEqual(['vinaya-not-a-program'])
  })
})
