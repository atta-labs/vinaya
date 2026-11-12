import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  GENERATED_ARTIFACT_SOURCES,
  NON_SOURCED_GENERATED_FILES,
  readGeneratedArtifactSources,
  repositoryImportTree,
  transitiveImportClosure
} from './generated-artifacts'
import { checkGeneratedArtifactsCovered } from './issue-validation'

const ROOT = resolve(import.meta.dir, '../../../../..')
const P = 'harness/processes/vinaya-strict/'

/** A minimal Issue body: the given pinned files in the Boundary and the given Surface. */
function body(pins: string[], surfaceIn: string[]): string {
  return [
    "## Planner's rationale",
    '',
    `**Boundary** — The task. Pinned files: ${pins.map((p) => `\`${p}\``).join(', ')}. Out: nothing else.`,
    '',
    '## Surface',
    '',
    `in: ${surfaceIn.join(', ')}`,
    'out: apps/vinaya-portal',
    ''
  ].join('\n')
}

describe('generated artifact sources', () => {
  it('maps every file the real installer writes, except the ones no source decides', async () => {
    const { buildInitOps } = await import('../../integration/artifacts')
    const generated = buildInitOps({
      owner: 'owner',
      repo: 'repo',
      hookDir: '.vinaya/hooks',
      selfHost: null,
      ciSetup: null,
      agents: new Set(['skills', 'claude', 'gemini'])
    }).flatMap((op) => (op.kind === 'create-file' || op.kind === 'managed-block' ? [op.path] : []))
    const mapped = Object.keys(GENERATED_ARTIFACT_SOURCES).filter((path) => !path.startsWith('.husky/'))
    expect([...mapped, ...NON_SOURCED_GENERATED_FILES].sort()).toEqual(generated.sort())
  })

  it('lists only real modules, each reachable from the module that writes the file', () => {
    const tree = repositoryImportTree(ROOT)
    for (const [path, sources] of Object.entries(GENERATED_ARTIFACT_SOURCES)) {
      const writer = sources[0] as string
      const reachable = new Set(transitiveImportClosure(writer, tree))
      for (const source of sources) {
        expect({ path, source, exists: existsSync(resolve(ROOT, source)) }).toEqual({ path, source, exists: true })
        expect({ path, source, reachable: reachable.has(source) }).toEqual({ path, source, reachable: true })
      }
    }
  })

  it('keeps each source set narrow: the Issue gate and brief modules are no source of any generated file', () => {
    const all = new Set(readGeneratedArtifactSources(ROOT).flatMap((a) => a.sources))
    for (const notASource of [
      `${P}tools/task-contract/issue-validation.ts`,
      `${P}tools/task-contract/brief-render.ts`,
      `${P}tools/task-contract/dispatch-task.ts`,
      'harness/kernel/tools/dev-tools-server.ts',
      'harness/kernel/tools/tool-catalog.ts'
    ])
      expect({ notASource, listed: all.has(notASource) }).toEqual({ notASource, listed: false })
  })

  // The pins of a real task that added two tool seats and paused because its brief forbade the regenerated
  // `.mcp.json`: the rule must still refuse it, naming that file and the root glob that reaches it.
  it('still refuses a task that pins the tool-seat table without reaching `.mcp.json`', () => {
    const pins = [
      `${P}tools/milestone/milestone-tools.ts`,
      `${P}thinking/architect/tools/architect-tools.ts`,
      `${P}integration/policies/roles.ts`,
      `${P}integration/server.ts`,
      `${P}integration/adapters.ts`,
      `${P}tests/integration/policies/roles.test.ts`
    ]
    const result = checkGeneratedArtifactsCovered(
      body(pins, [`${P}tools/milestone`, `${P}thinking/architect`, `${P}integration`, `${P}tests`]),
      readGeneratedArtifactSources(ROOT)
    )
    expect(result.status).toBe('fail')
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('generated file `.mcp.json`')
    expect(result.errors[0]).toContain('Add `*` to `in:`')
  })

  // The pins of a real task that changes the Issue gate, the brief render, dispatch and two kernel tool files:
  // none of them decides any generated file's content, so the rule must let it through.
  it('lets through a task that pins the Issue gate, the brief render, dispatch and the kernel tool files', () => {
    const pins = [
      `${P}tools/task-contract/plan-repair.ts`,
      `${P}tools/task-contract/issue-validation.ts`,
      `${P}tools/task-contract/brief-render.ts`,
      `${P}tools/task-contract/dispatch-task.ts`,
      `${P}executing/actions.ts`,
      'harness/kernel/tools/dev-tools-server.ts',
      'harness/kernel/tools/tool-catalog.ts',
      `${P}loops/dev-review/v2/flow-v2-live.ts`
    ]
    const result = checkGeneratedArtifactsCovered(
      body(pins, [`${P}tools`, `${P}executing`, 'harness/kernel/tools', `${P}loops/dev-review`]),
      readGeneratedArtifactSources(ROOT)
    )
    expect(result).toEqual({ status: 'pass', errors: [] })
  })
})
