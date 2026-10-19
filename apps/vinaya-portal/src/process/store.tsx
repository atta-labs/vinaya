'use client'

import { createContext, type ReactNode, use, useEffect, useMemo, useReducer } from 'react'
import { EnvironmentProvider } from './environment-context'
import { flows } from './fixtures'
import { type Cursor, cursorForStage, type Replay, replay } from './replay'
import type { Agent, Environment, FlowKey, LogEvent, Stage, Step } from './types'
import { defaultEnvironment } from './types'

/**
 * One state for the whole process page. The reader's scroll writes one
 * cursor (the step in view and how far through it they are); the Log, the
 * gates and the task states are replayed from the fixtures at that cursor
 * (`replay.ts`), so scrolling back undoes what scrolling forward did.
 */
type ProcessState = {
  flow: FlowKey
  /** Always equal to `env.agent`. */
  agent: Agent
  env: Environment
  /** True once the browser answered whether an environment was stored. */
  envKnown: boolean
  envChosen: boolean
  /** False on the setup screens (environment, then the four choices); true once the reader starts. */
  started: boolean
  cursor: Cursor
  /** Which view shows the walk: the scrolling sections or the whole diagram. Both read the same flow and cursor. */
  view: 'sections' | 'diagram'
  /** The stage the diagram picked, when it is finer than the cursor (merge vs the loop). Cleared when the walk moves to another step. */
  mapStage: Stage | null
  /** Events the reader caused by hand (a proposal created), on top of the replay. */
  extra: LogEvent[]
}

type Action =
  /** `keep` stays on the walk (the top-bar menu); otherwise back to setup. */
  | { type: 'flow'; flow: FlowKey; keep?: boolean }
  | { type: 'env'; env: Environment; chosen?: boolean }
  | { type: 'started'; started: boolean }
  | { type: 'cursor'; cursor: Cursor }
  | { type: 'log'; events: LogEvent[] }
  | { type: 'view'; view: ProcessState['view'] }
  /** The diagram picked a stage: the walk moves there too. */
  | { type: 'stage'; stage: Stage }

const initial = (flow: FlowKey, env: Environment = defaultEnvironment, chosen = false): ProcessState => ({
  flow,
  agent: env.agent,
  env,
  envKnown: chosen,
  envChosen: chosen,
  started: false,
  cursor: { step: 0, progress: 0 },
  view: 'sections',
  mapStage: null,
  extra: []
})

function reducer(s: ProcessState, a: Action): ProcessState {
  switch (a.type) {
    case 'flow':
      return {
        ...initial(a.flow, s.env, s.envChosen),
        envKnown: s.envKnown,
        started: a.keep ? s.started : false,
        view: s.view
      }
    case 'env':
      return { ...s, env: a.env, agent: a.env.agent, envKnown: true, envChosen: a.chosen ?? s.envChosen }
    case 'started':
      return { ...s, started: a.started, cursor: { step: 0, progress: 0 }, mapStage: null, extra: [] }
    case 'cursor':
      return { ...s, cursor: a.cursor, mapStage: a.cursor.step === s.cursor.step ? s.mapStage : null }
    case 'view':
      return { ...s, view: a.view }
    case 'stage':
      return { ...s, cursor: cursorForStage(s.flow, a.stage), mapStage: a.stage }
    case 'log':
      return { ...s, extra: [...s.extra, ...a.events] }
  }
}

type Ctx = { state: ProcessState; dispatch: (a: Action) => void; currentStep: Step; live: Replay }
const ProcessContext = createContext<Ctx | null>(null)

const ENV_KEY = 'vinaya.environment'
function readStoredEnvironment(): Environment | null {
  try {
    const raw = localStorage.getItem(ENV_KEY)
    if (!raw) return null
    const e = JSON.parse(raw) as Partial<Environment>
    if (
      (e.os === 'mac' || e.os === 'linux') &&
      (e.agent === 'claude' || e.agent === 'codex') &&
      (e.mode === 'terminal' || e.mode === 'chat')
    )
      return {
        os: e.os,
        agent: e.agent,
        mode: e.mode,
        // Stored before these two existed: the defaults fill them.
        tracker: e.tracker === 'jira' ? 'jira' : defaultEnvironment.tracker,
        logServer:
          e.logServer === 'grafana' || e.logServer === 'datadog' || e.logServer === 'cloudflare'
            ? e.logServer
            : defaultEnvironment.logServer
      }
  } catch {}
  return null
}
export function storeEnvironment(env: Environment | null) {
  try {
    if (env) localStorage.setItem(ENV_KEY, JSON.stringify(env))
    else localStorage.removeItem(ENV_KEY)
  } catch {}
}

/** `started`: a flow's own subpage, which opens on the walk; the wizard's page starts at setup. */
export function ProcessProvider({
  flow = 'feature',
  started = false,
  children
}: {
  flow?: FlowKey
  started?: boolean
  children: ReactNode
}) {
  const [state, dispatch] = useReducer(reducer, flow, (f) => ({ ...initial(f), started }))
  // Hydrate the stored environment once, after mount, so the server and first client render agree.
  useEffect(() => {
    const stored = readStoredEnvironment()
    dispatch(
      stored ? { type: 'env', env: stored, chosen: true } : { type: 'env', env: defaultEnvironment, chosen: false }
    )
  }, [])
  const currentStep = flows[state.flow].steps[state.cursor.step] as Step
  const live = useMemo(() => {
    const r = replay(state.flow, state.agent, state.cursor)
    return { ...r, log: [...r.log, ...state.extra] }
  }, [state.flow, state.agent, state.cursor, state.extra])
  const value = useMemo(() => ({ state, dispatch, currentStep, live }), [state, currentStep, live])
  return (
    <ProcessContext value={value}>
      <EnvironmentProvider env={state.env}>{children}</EnvironmentProvider>
    </ProcessContext>
  )
}

export function useProcess() {
  const ctx = use(ProcessContext)
  if (!ctx) throw new Error('useProcess outside ProcessProvider')
  return ctx
}
