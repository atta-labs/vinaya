import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  GENERATED_ARTIFACT_WRITERS,
  NON_SOURCED_GENERATED_FILES,
  readGeneratedArtifactSources,
  directSources,
  repositoryImportTree
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
    const mapped = Object.keys(GENERATED_ARTIFACT_WRITERS).filter((path) => !path.startsWith('.husky/'))
    expect([...mapped, ...NON_SOURCED_GENERATED_FILES].sort()).toEqual(generated.sort())
  })

  it('lists only real files: the writer and its direct imports', () => {
    const tree = repositoryImportTree(ROOT)
    for (const artifact of readGeneratedArtifactSources(ROOT)) {
      const direct = new Set(directSources(artifact.writer, tree))
      for (const source of artifact.sources) {
        expect({ source, exists: existsSync(resolve(ROOT, source)) }).toEqual({ source, exists: true })
        const imported = source === artifact.writer || direct.has(source)
        expect({ path: artifact.path, source, imported }).toEqual({ path: artifact.path, source, imported: true })
      }
    }
  })

  // This repository installs its hooks under `.vinaya/hooks` and has no `.husky` folder. A generated file the
  // repository does not have cannot drift, and Surface cannot name a folder with no tracked file, so the rule
  // must not ask for one: asking would refuse every task that pins the installer whatever its Surface says.
  it('lists only generated files the repository has', () => {
    const paths = readGeneratedArtifactSources(ROOT).map((a) => a.path)
    for (const path of paths) expect({ path, exists: existsSync(resolve(ROOT, path)) }).toEqual({ path, exists: true })
    expect(paths.some((path) => path.startsWith('.husky/'))).toBe(false)
    expect(paths).toContain('.vinaya/hooks/pre-push')
  })

  it('does not ask a task that pins the installer to reach a generated file the repository lacks', () => {
    const result = checkGeneratedArtifactsCovered(
      body([`${P}integration/artifacts.ts`], [`${P}integration`, '*', '.github/workflows', '.gemini', '.vinaya/hooks']),
      readGeneratedArtifactSources(ROOT)
    )
    expect(result).toEqual({ status: 'pass', errors: [] })
  })

  // The modules a review found writing content into generated files, each checked against what the rule now reads.
  it("counts the constants a writer emits as sources, and leaves a role's doctrine prose out", () => {
    const byPath = new Map(readGeneratedArtifactSources(ROOT).map((a) => [a.path, new Set(a.sources)]))
    const workflow = byPath.get('.github/workflows/vinaya-review-verdict.yml')
    for (const source of [
      `${P}tools/task-contract/verdict-extraction.ts`,
      `${P}tools/task-contract/waiver-label.ts`,
      `${P}tools/review-gate-check-name.ts`,
      'harness/kernel/gates/ring0-hooks/pre-push/pre-push-test-runner.ts',
      `${P}tools/pre-push-ready-policy.ts`,
      `${P}tools/programs.ts`
    ])
      expect({ source, listed: workflow?.has(source) }).toEqual({ source, listed: true })
    const operator = byPath.get('.agents/skills/vinaya-operator/SKILL.md')
    expect(operator?.has(`${P}executing/operator/doctrine.md`)).toBe(false)
    expect(operator?.has(`${P}tools/doctrine/doctrine-map.ts`)).toBe(true)
    expect(byPath.get('.mcp.json')?.has(`${P}integration/server.ts`)).toBe(true)
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
