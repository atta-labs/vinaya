import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { MemorySaver } from '@langchain/langgraph'
import type { SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import {
  startProcessRun,
  type ActionRegistry,
  type ProcessRunOptions
} from '../../../harness/dev-process/engine-runtime/run-process'
import { ACTION_BINDINGS, createRoleLaunchers, decisions } from '../executing/actions'

// A revised round continues the Developer's own vendor session, as the standalone loop resumes its
// Developer (`claude -p -r <id>`, `codex exec resume <id>`), on both vendors.
const loaded = loadProcess(resolve(import.meta.dir, '..'))
const ROLES = ['developer', 'code-reviewer', 'security-reviewer']

function roleOf(args: readonly string[]): string {
  const joined = args.join(' ')
  return ROLES.find((role) => joined.includes(`/${role}/`)) ?? 'unknown'
}

function agent(lines: string[]): SpawnedProcessLike {
  const close: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  return {
    stdin: {
      write: () => {},
      end: () =>
        setTimeout(() => {
          stdout?.(`${lines.join('\n')}\n`)
          for (const listener of close) listener(0)
        }, 0)
    },
    stdout: {
      on: (_e, l) => {
        stdout = l as (chunk: string) => void
      }
    },
    stderr: { on: () => {} },
    on: ((event: string, l: (code: number | null) => void) => {
      if (event === 'close') close.push(l)
    }) as SpawnedProcessLike['on'],
    kill: () => {}
  }
}

const turn = JSON.stringify({ turnResult: { schemaVersion: 1, status: 'completed', summary: 's' } })
const STREAMS = {
  'claude-code': (n: number) => [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: `claude-session-${n}` }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: `claude-session-${n}`,
      structured_output: JSON.parse(turn)
    })
  ],
  codex: (n: number) => [
    JSON.stringify({ type: 'thread.started', thread_id: `codex-thread-${n}` }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: turn } }),
    JSON.stringify({ type: 'turn.completed', usage: {} })
  ]
} as const

for (const vendor of ['claude-code', 'codex'] as const)
  describe(`the Developer's session on ${vendor}`, () => {
    for (const [why, gates, assessments] of [
      ['after a revise decision', [0], [1, 0]],
      ['after a red gate', [1, 0], [0]]
    ] as const)
      test(`round 2 launches with the round-1 session id, ${why}`, async () => {
        const launches: string[][] = []
        const contexts: unknown[] = []
        let developerRuns = 0
        const gateQueue = [...gates]
        const assessQueue = [...assessments]
        const next = (q: number[]) => (q.length > 1 ? (q.shift() as number) : (q[0] ?? 0))
        const actions: ActionRegistry = Object.fromEntries(
          Object.keys(ACTION_BINDINGS).map((name) => [
            name,
            async () => {
              if (name === 'harness.run-gates') return { exitCode: next(gateQueue) }
              if (name === 'vinaya.assess-round') return { exitCode: next(assessQueue) }
              if (name === 'vinaya.classify-gate-result') return { exitCode: 0 }
              return { exitCode: 0 }
            }
          ])
        )
        const roles = createRoleLaunchers({ vendor, generatedRoot: mkdtempSync(`${tmpdir()}/session-roles-`) })
        const options: ProcessRunOptions = {
          process: loaded,
          question: 'the task',
          bindings: { actions, decisions, roles },
          checkpointer: new MemorySaver(),
          workingDirectoryRoot: mkdtempSync(`${tmpdir()}/session-root-`),
          continueSessions: ['develop'],
          stepPrompts: {
            develop: (rendered, _results, context) => {
              contexts.push(context)
              return rendered
            }
          },
          spawnFn: (_command, args) => {
            const role = roleOf(args)
            if (role === 'developer') {
              developerRuns += 1
              launches.push([...args])
              return agent(STREAMS[vendor](developerRuns))
            }
            return agent([JSON.stringify({ reviewResult: {} })])
          }
        }
        const outcome = await startProcessRun(options)
        expect(outcome.reason).toBe('completed')
        expect(launches).toHaveLength(2)
        const first = launches[0] as string[]
        const second = launches[1] as string[]
        const firstSession = vendor === 'claude-code' ? 'claude-session-1' : 'codex-thread-1'
        expect(first).not.toContain(firstSession)
        if (vendor === 'claude-code') expect(second.slice(0, 3)).toEqual(['-p', '--resume', firstSession])
        else expect(second.slice(0, 3)).toEqual(['exec', 'resume', firstSession])
        // Everything after the resume form is the first launch's own argv.
        expect(second.slice(3)).toEqual(first.slice(1))
        expect(contexts).toEqual([{}, { resumeSessionId: firstSession }])
      })
  })
