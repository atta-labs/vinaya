import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { DEV_TOOL_NAMES, READ_SOURCE_TOOL } from '../../../apps/cli/src/lib/task-tools/dev-tools-server'
import type { DevToolContext } from '../../../apps/cli/src/lib/task-tools/dev-tools-server'
import type { BoundFunctions } from '../executing/actions'
import { liveHandoffDeps, type HandoffDeps } from '../executing/handoff'
import {
  BOUND_FUNCTION_CLASSES,
  boundFunctionRecorders,
  classificationGaps,
  createShadowRecorder,
  DEV_TOOL_CLASSES,
  effectKeys,
  HANDOFF_DEP_CLASSES,
  shadowBoundFunctions,
  shadowDevToolContext,
  shadowHandoffDeps,
  shadowRuntimeDirRefusal,
  type ShadowRecorder
} from '../executing/shadow'
import { parseArgs, prepareShadowCheckout, runShadowEngine, type ShadowEngineRunOptions } from '../bin/run-engine'

const ROOT = resolve(import.meta.dir, '../../..')
const dirs: string[] = []
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The member names a source file declares for `name`, an interface or a type alias of an object type, read with the TypeScript parser. */
function declaredMembers(file: string, name: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true)
  let members: ts.NodeArray<ts.TypeElement> | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) members = node.members
    else if (ts.isTypeAliasDeclaration(node) && node.name.text === name && ts.isTypeLiteralNode(node.type))
      members = node.type.members
    else ts.forEachChild(node, visit)
  }
  visit(source)
  if (members === undefined) throw new Error(`${file} declares no ${name}`)
  return members.map((member) => {
    if (!member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)))
      throw new Error(`${name} in ${file} has a member with no plain name`)
    return member.name.text
  })
}

const REGISTRIES = [
  { file: 'processes/vinaya/executing/actions.ts', name: 'BoundFunctions', classes: BOUND_FUNCTION_CLASSES },
  { file: 'processes/vinaya/executing/handoff.ts', name: 'HandoffDeps', classes: HANDOFF_DEP_CLASSES },
  { file: 'apps/cli/src/lib/task-tools/dev-tools-server.ts', name: 'DevToolContext', classes: DEV_TOOL_CLASSES }
] as const

/** A recorder that keeps attempts in memory. */
function memoryRecorder(): ShadowRecorder & { names: () => string[] } {
  const attempts: Array<{ registry: 'bound' | 'handoff' | 'dev-tool'; name: string; at: string; args: unknown[] }> = []
  return {
    refuse: (registry, name, args) => {
      attempts.push({ registry, name, at: 'now', args: [...args] })
    },
    attempts: () => attempts,
    names: () => attempts.map((attempt) => `${attempt.registry}:${attempt.name}`)
  }
}

/** A function that fails the test the moment a shadow run reaches it. */
const liveWriter =
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`the live ${name} was reached`)
  }

describe('the shadow classification', () => {
  for (const registry of REGISTRIES) {
    test(`classifies every member ${registry.name} declares, and no other`, () => {
      const declared = declaredMembers(registry.file, registry.name)
      expect(declared.length).toBeGreaterThan(0)
      expect(classificationGaps(declared, registry.classes)).toEqual({ unclassified: [], stale: [] })
    })
  }

  test('an unclassified key fails: a member added to a registry is named until it is classified', () => {
    const declared = [...declaredMembers('processes/vinaya/executing/actions.ts', 'BoundFunctions'), 'pushTaskBranch']
    expect(classificationGaps(declared, BOUND_FUNCTION_CLASSES).unclassified).toEqual(['pushTaskBranch'])
    const tools = [...declaredMembers('apps/cli/src/lib/task-tools/dev-tools-server.ts', 'DevToolContext'), 'mergePr']
    expect(classificationGaps(tools, DEV_TOOL_CLASSES).unclassified).toEqual(['mergePr'])
    const removed = declaredMembers('processes/vinaya/executing/handoff.ts', 'HandoffDeps').filter(
      (name) => name !== 'postPauseComment'
    )
    expect(classificationGaps(removed, HANDOFF_DEP_CLASSES).stale).toEqual(['postPauseComment'])
  })

  test('every tool the Developer is served has a classified context method', () => {
    const camel = (name: string) => name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
    const served = [...DEV_TOOL_NAMES, READ_SOURCE_TOOL].map(camel)
    expect(served.filter((name) => !(name in DEV_TOOL_CLASSES))).toEqual([])
  })

  test('names the forge writers as effects', () => {
    expect(effectKeys(BOUND_FUNCTION_CLASSES).sort()).toEqual([
      'createTaskWorktree',
      'postMarkedComment',
      'publishRound',
      'rerunFailedWorkflowJobs',
      'updatePrBody',
      'writeDeferredFindingsIssue'
    ])
    expect(effectKeys(HANDOFF_DEP_CLASSES).sort()).toEqual(['postIssuePauseComment', 'postPauseComment'])
    expect(effectKeys(DEV_TOOL_CLASSES).sort()).toEqual([
      'openPullRequest',
      'publishChanges',
      'refreshEvidence',
      'updatePullRequestBody'
    ])
  })
})

describe('the refusing recorders', () => {
  test('replace every effect bound function, refuse it and record the attempt, and keep the rest', async () => {
    const recorder = memoryRecorder()
    expect(Object.keys(boundFunctionRecorders(recorder)).sort()).toEqual(effectKeys(BOUND_FUNCTION_CLASSES).sort())
    const live = Object.fromEntries(
      Object.keys(BOUND_FUNCTION_CLASSES).map((name) => [name, liveWriter(name)])
    ) as unknown as BoundFunctions
    const shadow = shadowBoundFunctions(live, recorder)
    for (const [name, kind] of Object.entries(BOUND_FUNCTION_CLASSES)) {
      const fn = shadow[name as keyof BoundFunctions]
      if (kind === 'effect')
        expect({ name, live: fn === live[name as keyof BoundFunctions] }).toEqual({ name, live: false })
      else expect({ name, kept: fn === live[name as keyof BoundFunctions] }).toEqual({ name, kept: true })
    }
    shadow.createTaskWorktree?.('task/x/1')
    shadow.publishRound?.('/runtime', { round: 1 } as never)
    await shadow.updatePrBody?.({ prNumber: 1, body: 'b', repo: null })
    expect(shadow.writeDeferredFindingsIssue?.({ prNumber: 1, entries: [] })).toEqual({ issue: 0 })
    expect(() => shadow.rerunFailedWorkflowJobs?.(7)).toThrow('shadow mode refuses every forge effect')
    expect(shadow.postMarkedComment?.('pr', '1', 'round-1', 'body')).toBe('shadow-refused:round-1')
    expect(recorder.names().sort()).toEqual(
      effectKeys(BOUND_FUNCTION_CLASSES)
        .map((name) => `bound:${name}`)
        .sort()
    )
  })

  test('a run given no bound functions still gets a recorder for every effect', () => {
    const shadow = shadowBoundFunctions(undefined, memoryRecorder())
    for (const name of effectKeys(BOUND_FUNCTION_CLASSES))
      expect(typeof shadow[name as keyof BoundFunctions]).toBe('function')
  })

  test('replace the two pause posts and keep the control-store records', () => {
    const recorder = memoryRecorder()
    const live: HandoffDeps = {
      ...liveHandoffDeps(() => {}),
      postPauseComment: liveWriter('postPauseComment'),
      postIssuePauseComment: liveWriter('postIssuePauseComment')
    }
    const shadow = shadowHandoffDeps(live, recorder)
    expect(shadow.postPauseComment(1, 1, 'abc', 2, 'escalation')).toEqual({ attempts: 0, posted: false })
    expect(shadow.postIssuePauseComment(1, 'task/x/1', 1, 'escalation')).toEqual({ attempts: 0, posted: false })
    expect(recorder.names()).toEqual(['handoff:postPauseComment', 'handoff:postIssuePauseComment'])
    for (const [name, kind] of Object.entries(HANDOFF_DEP_CLASSES))
      if (kind !== 'effect') expect(shadow[name as keyof HandoffDeps]).toBe(live[name as keyof HandoffDeps])
  })

  test('replace the four publication tools with a structured refusal and keep the reads and the checks', async () => {
    const recorder = memoryRecorder()
    const live = Object.fromEntries(
      Object.keys(DEV_TOOL_CLASSES).map((name) => [name, liveWriter(name)])
    ) as unknown as DevToolContext
    const shadow = shadowDevToolContext(live, recorder)
    const calls: Record<string, () => Promise<unknown>> = {
      publishChanges: () => shadow.publishChanges('Feat(cli): Ship it'),
      openPullRequest: () => shadow.openPullRequest('title', 'body'),
      updatePullRequestBody: () => shadow.updatePullRequestBody('body'),
      refreshEvidence: () => shadow.refreshEvidence()
    }
    for (const name of effectKeys(DEV_TOOL_CLASSES)) {
      const result = (await calls[name]!()) as { ok: boolean; error?: { check: string; effectState: string } }
      expect({ name, ok: result.ok, check: result.error?.check, effect: result.error?.effectState }).toEqual({
        name,
        ok: false,
        check: 'shadow-mode',
        effect: 'not_started'
      })
    }
    expect(recorder.names().sort()).toEqual(
      effectKeys(DEV_TOOL_CLASSES)
        .map((name) => `dev-tool:${name}`)
        .sort()
    )
    for (const [name, kind] of Object.entries(DEV_TOOL_CLASSES))
      if (kind !== 'effect') expect(shadow[name as keyof DevToolContext]).toBe(live[name as keyof DevToolContext])
  })

  test('the file recorder appends one line per attempt and reads every leg back', () => {
    const path = join(scratch('shadow-recorder-'), 'run', 'shadow-refused.jsonl')
    createShadowRecorder(path).refuse('bound', 'publishRound', ['/runtime', { body: 'x'.repeat(500) }])
    const again = createShadowRecorder(path)
    again.refuse('dev-tool', 'publishChanges', ['Feat(cli): Ship it'])
    const attempts = again.attempts()
    expect(attempts.map((attempt) => attempt.name)).toEqual(['publishRound', 'publishChanges'])
    expect(String(attempts[0]?.args[1]).length).toBeLessThan(260)
  })
})

describe('the shadow runtime directory', () => {
  test('is refused when it is the live runtime directory, by any path to it', () => {
    const live = scratch('shadow-live-')
    expect(shadowRuntimeDirRefusal(live, live)).toContain("the task's live runtime directory")
    expect(shadowRuntimeDirRefusal(`${live}/./`, live)).not.toBeNull()
    const link = join(scratch('shadow-link-'), 'live')
    symlinkSync(live, link)
    expect(shadowRuntimeDirRefusal(link, live)).not.toBeNull()
    expect(shadowRuntimeDirRefusal(join(live, 'shadow'), live)).toBeNull()
    expect(shadowRuntimeDirRefusal(scratch('shadow-own-'), live)).toBeNull()
  })

  test('a shadow run refuses to start in the live directory before it takes a lock or writes a file', async () => {
    const live = scratch('shadow-live-')
    const options = { args: { task: 7, agent: 'claude', dryRun: false }, runtimeDir: live, liveRuntimeDir: live }
    await expect(runShadowEngine(options as unknown as ShadowEngineRunOptions)).rejects.toThrow(
      "the task's live runtime directory"
    )
    expect(readdirSync(live)).toEqual([])
  })
})

describe('the runner script', () => {
  test('accepts a shadow flag naming the shadow run’s runtime directory', () => {
    expect(parseArgs(['--task', '7', '--agent', 'codex', '--shadow', '/tmp/shadow-7'])).toEqual({
      task: 7,
      agent: 'codex',
      dryRun: false,
      shadow: '/tmp/shadow-7'
    })
    expect(parseArgs(['--task', '7', '--agent', 'codex']).shadow).toBeUndefined()
    expect(() => parseArgs(['--task', '7', '--agent', 'codex', '--shadow'])).toThrow(
      '--shadow takes a runtime directory'
    )
    expect(() => parseArgs(['--task', '7', '--agent', 'codex', '--shadow', '--dry-run'])).toThrow(
      '--shadow takes a runtime directory'
    )
  })

  test('copies the task worktree into the shadow directory, at the live head, with the live remote-tracking refs', () => {
    const root = scratch('shadow-checkout-')
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=stub', '-c', 'user.email=stub@example.com', '-c', 'commit.gpgsign=false', ...args],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim()
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'sample.ts'), 'export const value = 1\n')
    git(repo, 'add', 'sample.ts')
    git(repo, 'commit', '-q', '-m', 'base')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    const branch = 'task/shadow/1'
    const live = join(repo, '.worktrees', branch)
    git(repo, 'worktree', 'add', '-q', '-b', branch, live)
    writeFileSync(join(live, 'sample.ts'), 'export const value = 2\n')
    git(live, 'commit', '-q', '-am', 'task work')
    const liveHead = git(live, 'rev-parse', 'HEAD')
    const worktreesBefore = git(repo, 'worktree', 'list', '--porcelain')

    const shadowDir = join(root, 'shadow')
    const checkout = prepareShadowCheckout({ repoRoot: repo, branch, shadowRuntimeDir: shadowDir })
    const copy = join(checkout, '.worktrees', branch)
    expect(checkout.startsWith(shadowDir)).toBe(true)
    expect(git(copy, 'rev-parse', 'HEAD')).toBe(liveHead)
    expect(git(copy, 'branch', '--show-current')).toBe(branch)
    expect(git(copy, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(repo, 'rev-parse', 'refs/remotes/origin/main'))
    expect(git(checkout, 'remote', 'get-url', '--push', 'origin')).toBe('shadow-mode-never-pushes')
    // The live checkout is untouched: no new worktree, the same head, and work in the copy stays in the copy.
    writeFileSync(join(copy, 'sample.ts'), 'export const value = 3\n')
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
    expect(git(live, 'rev-parse', 'HEAD')).toBe(liveHead)
    expect(readFileSync(join(live, 'sample.ts'), 'utf8')).toBe('export const value = 2\n')
    // A second start reuses the copy.
    expect(prepareShadowCheckout({ repoRoot: repo, branch, shadowRuntimeDir: shadowDir })).toBe(checkout)
  })
})
