import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConnectionSocket, MissionControlState, RepositoryState } from '@/lib/mission-control-connection'
import type { CoverageView, StatusView, TaskView } from '@/lib/mission-control-protocol'
import { ageText, boardStatus, LiveList, MissionControlLiveList } from './live-list'

const NOW = Date.parse('2026-11-01T10:30:00.000Z')
const MIN = 60_000

function task(n: number, over: Partial<TaskView> = {}): TaskView {
  return {
    task: n,
    title: `Task ${n}`,
    state: 'running',
    amber: false,
    reason: null,
    decision: null,
    pr: null,
    nowLine: 'Round 1 under way',
    lastSign: NOW - 2 * MIN,
    whoActs: 'developer',
    command: null,
    model: 'opus',
    machine: null,
    reviewerRoles: [],
    attentionSince: null,
    story: [],
    rounds: [],
    tokens: {},
    ...over
  }
}

const LIVE: StatusView = { live: true, connection: 'live', reason: null }
const COMPLETE: CoverageView = { complete: true, limits: [] }

function repo(id: string, tasks: TaskView[], over: Partial<RepositoryState> = {}): RepositoryState {
  return {
    id,
    remote: `acme/${id}`,
    status: LIVE,
    coverage: COMPLETE,
    tasks: Object.fromEntries(tasks.map((t) => [t.task, t])),
    ...over
  }
}

function stateOf(repositories: RepositoryState[], over: Partial<MissionControlState> = {}): MissionControlState {
  return {
    phase: 'open',
    generation: 1,
    repositories: Object.fromEntries(repositories.map((r) => [r.id, r])),
    lastUpdateAt: NOW,
    attempts: 0,
    ...over
  }
}

const html = (state: MissionControlState) => renderToStaticMarkup(createElement(LiveList, { state, now: NOW }))

describe('the live list rows', () => {
  it('names the repository on every row, so identical task numbers stay distinct', () => {
    const out = html(stateOf([repo('widgets', [task(7)]), repo('gadgets', [task(7)])]))
    expect(out).toContain('acme/widgets')
    expect(out).toContain('acme/gadgets')
    expect(out.match(/data-task-row/g)).toHaveLength(2)
  })

  it('shows the recorded title, or says it was not recorded', () => {
    const out = html(stateOf([repo('widgets', [task(1, { title: 'Ship it' }), task(2, { title: null })])]))
    expect(out).toContain('Ship it')
    expect(out).toContain('Title not recorded')
  })

  it('shows state label, now-line, model, pull request and age, and says unknown for what is missing', () => {
    const known = html(stateOf([repo('widgets', [task(3, { state: 'ready_to_merge', pr: 42, model: 'opus' })])]))
    expect(known).toContain('Ready to merge')
    expect(known).toContain('Round 1 under way')
    expect(known).toContain('developer / opus')
    expect(known).toContain('#42')
    expect(known).toContain('2m ago')
    const unknown = html(stateOf([repo('widgets', [task(3, { model: null, pr: null, lastSign: 0 })])]))
    expect(unknown).toContain('model unknown')
    expect(unknown).toContain('data-cell="pr">unknown')
    expect(unknown).toContain('data-cell="last-sign">unknown')
    expect(unknown).not.toContain('0s ago')
  })

  it('orders rows by the state rank the server uses, then repository, then task number', () => {
    const out = html(
      stateOf([
        repo('widgets', [task(2, { state: 'running' }), task(1, { state: 'needs_you' })]),
        repo('gadgets', [task(1, { state: 'running' })])
      ])
    )
    const order = [...out.matchAll(/data-repository="(\w+)" data-task="(\d+)" data-state="(\w+)"/g)].map((m) =>
      m.slice(1).join(':')
    )
    expect(order).toEqual(['widgets:1:needs_you', 'gadgets:1:running', 'widgets:2:running'])
  })

  it('shows the branch as unknown, since the Log carries none', () => {
    expect(html(stateOf([repo('widgets', [])]))).toContain('data-board-field="branch">unknown')
  })
})

describe('what the page says about its connection', () => {
  const kind = (state: MissionControlState) => boardStatus(state).kind

  it('is connecting before the first snapshot, never an empty board', () => {
    const state = stateOf([], { phase: 'connecting', lastUpdateAt: null })
    expect(kind(state)).toBe('connecting')
    expect(html(state)).not.toContain('No tasks in this Log')
  })

  it('is catching up while the repository is read, and empty only once it is live and complete', () => {
    const catching = stateOf([
      repo('widgets', [], { status: { live: false, connection: 'catching-up', reason: null } })
    ])
    expect(kind(catching)).toBe('catching-up')
    expect(html(catching)).not.toContain('No tasks in this Log')
    const empty = stateOf([repo('widgets', [])])
    expect(kind(empty)).toBe('empty')
    expect(html(empty)).toContain('No tasks in this Log.')
  })

  it('is live with rows', () => {
    expect(kind(stateOf([repo('widgets', [task(1)])]))).toBe('live')
  })

  it('is source-limited when the coverage declares a limit, and then no empty claim is made', () => {
    const limited = stateOf([
      repo('widgets', [], {
        coverage: { complete: false, limits: [{ kind: 'opening-limited', detail: 'started at 5000' }] }
      })
    ])
    expect(kind(limited)).toBe('source-limited')
    const out = html(limited)
    expect(out).toContain('started at 5000')
    expect(out).not.toContain('No tasks in this Log')
  })

  it('names a refused credential apart from an unreachable source', () => {
    const refused = stateOf([
      repo('widgets', [], { status: { live: false, connection: 'unavailable', reason: 'the server answered 401' } })
    ])
    expect(kind(refused)).toBe('credential-failure')
    const down = stateOf([
      repo('widgets', [], { status: { live: false, connection: 'unavailable', reason: 'connection refused' } })
    ])
    expect(kind(down)).toBe('disconnected')
  })

  it('keeps the rows and says disconnected when the browser or the upstream drops', () => {
    for (const state of [
      stateOf([repo('widgets', [task(1)])], { phase: 'reconnecting', attempts: 1 }),
      stateOf([repo('widgets', [task(1)])], { phase: 'failed', attempts: 21 }),
      stateOf([repo('widgets', [task(1)], { status: { live: false, connection: 'reconnecting', reason: null } })])
    ]) {
      expect(kind(state)).toBe('disconnected')
      const out = html(state)
      expect(out).toContain('data-task-row')
      expect(out).not.toContain('No tasks')
    }
  })
})

describe('ages', () => {
  it('advance with the local clock', () => {
    expect(ageText(NOW, NOW - 5_000)).toBe('5s ago')
    expect(ageText(NOW + 10 * MIN, NOW - 5_000)).toBe('10m ago')
    expect(ageText(NOW + 3 * 60 * MIN, NOW)).toBe('3h ago')
    expect(ageText(NOW, Number.NaN)).toBe('unknown')
  })
})

class FakeSocket implements ConnectionSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
}

describe('the connected list', () => {
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const saved = new Map<string, unknown>()
  let dom: JSDOM

  beforeAll(() => {
    dom = new JSDOM('<!doctype html><div id="root"></div>')
    for (const key of globals) saved.set(key, (globalThis as Record<string, unknown>)[key])
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node,
      IS_REACT_ACT_ENVIRONMENT: true
    })
  })
  afterAll(() => {
    for (const key of globals) {
      const value = saved.get(key)
      if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
      else (globalThis as Record<string, unknown>)[key] = value
    }
    dom.window.close()
  })

  it('updates a row from a task frame without a reload and never opens a socket of its own beyond the one given', async () => {
    const sockets: FakeSocket[] = []
    const container = document.getElementById('root') as HTMLElement
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(MissionControlLiveList, {
          createSocket: () => {
            const socket = new FakeSocket()
            sockets.push(socket)
            return socket
          },
          clock: () => NOW
        })
      )
    })
    expect(sockets).toHaveLength(1)
    expect(container.querySelector('[data-board-status]')?.getAttribute('data-board-status')).toBe('connecting')

    const view = (tasks: TaskView[]) => ({
      v: 1,
      type: 'snapshot',
      generation: 1,
      repositories: [{ id: 'r1', remote: 'acme/widgets', status: LIVE, coverage: COMPLETE, tasks }]
    })
    await act(async () => {
      sockets[0]?.onmessage?.({ data: JSON.stringify(view([task(7)])) })
    })
    expect(container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(container.querySelector('[data-board-status]')?.getAttribute('data-board-status')).toBe('live')

    await act(async () => {
      sockets[0]?.onmessage?.({
        data: JSON.stringify({
          v: 1,
          type: 'task',
          generation: 1,
          repository: 'r1',
          task: task(7, { state: 'presumed_dead' })
        })
      })
    })
    expect(container.querySelector('[data-task="7"]')?.getAttribute('data-state')).toBe('presumed_dead')
    expect(container.textContent).toContain('Presumed dead')

    await act(async () => {
      sockets[0]?.onclose?.()
    })
    expect(container.querySelector('[data-board-status]')?.getAttribute('data-board-status')).toBe('disconnected')
    expect(container.querySelector('[data-task="7"]')).not.toBeNull()
    await act(async () => root.unmount())
  })
})
