/**
 * The process model. Every component on the site renders from these types and
 * nothing else; the four flows in `./fixtures` are the only data.
 */

export type Stage =
  | 'upstream'
  | 'architect'
  | 'planner'
  | 'loop'
  | 'gates'
  | 'merge'
  | 'archive'
  | 'observed'
  | 'improve'

/** Colour language of the document: one hue per stage family. */
export type Tone = 'think' | 'exec' | 'retro' | 'hot' | 'log' | 'product'

export const toneOfStage: Record<Stage, Tone> = {
  upstream: 'product',
  architect: 'think',
  planner: 'think',
  loop: 'exec',
  gates: 'exec',
  merge: 'exec',
  archive: 'retro',
  observed: 'log',
  improve: 'retro'
}

export type FlowKey = 'feature' | 'medium' | 'backlog' | 'hot'

export type Agent = 'claude' | 'codex'
export type Os = 'mac' | 'linux'
/** Where the reader works: in a terminal, or in the agent's chat app. */
export type Mode = 'terminal' | 'chat'

/** The reader's environment. Chosen once, kept in the browser, changeable from the top bar. */
/** Where product writes the need: the project management tool. */
export type Tracker = 'linear' | 'jira'
/** Where the Log is shipped. */
export type LogServer = 'cloudflare' | 'grafana' | 'datadog'

export type Environment = { os: Os; agent: Agent; mode: Mode; tracker: Tracker; logServer: LogServer }
export const trackerLabel: Record<Tracker, string> = { linear: 'Linear', jira: 'Jira' }
export const logServerLabel: Record<LogServer, string> = {
  cloudflare: 'Cloudflare',
  grafana: 'Grafana',
  datadog: 'Datadog'
}

/**
 * Copy can name the reader's tools: `{tracker}` becomes Linear or Jira,
 * `{project}` what product writes there (a Project in Linear, an Epic in Jira),
 * `{logServer}` where the Log ships. With no environment (the design system,
 * the diagram on its own) the words stay generic.
 */
export function fillEnv(text: string, env: Environment | null): string {
  const epic = env?.tracker === 'jira'
  return (
    text
      // the article follows the word: a Project, an Epic
      .replace(/\b([Aa]) \{project\}/g, (_, a: string) => `${epic ? `${a}n` : a} {project}`)
      .replaceAll('{tracker}', env ? trackerLabel[env.tracker] : 'Linear or Jira')
      .replaceAll('{project}', epic ? 'Epic' : 'Project')
      .replaceAll('{logServer}', env ? logServerLabel[env.logServer] : 'Any log server')
  )
}

export const defaultEnvironment: Environment = {
  os: 'mac',
  agent: 'claude',
  mode: 'chat',
  tracker: 'linear',
  logServer: 'cloudflare'
}
export const sandboxOf: Record<Os, string> = { mac: 'Seatbelt', linux: 'seccomp' }

/** One line in a simulated chat or terminal. */
type ChatLineKind = 'cmd' | 'out' | 'skill' | 'me' | 'ag' | 'hook' | 'ok' | 'ev' | 'hl'

/** A Log event, named as the real families name them: `family.event`. */
export type LogEvent = { name: string; detail: string; tone?: Tone }

/** 0 = idle, 1 = running, 2 = green, per ring. */
export type GateState = [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2]

/** What one typed line does to the rest of the page when it appears. */
type LineEffect = {
  log?: LogEvent[]
  gates?: GateState
  scene?: Partial<SceneState>
}

export type ChatLine = { kind: ChatLineKind; text: string; effect?: LineEffect }

export type Surface = 'claude' | 'codex' | 'terminal'

export type Task = {
  issue: number
  /** Position in its tranche; null for a backlog or hot Issue. */
  n: number | null
  title: string
  file: string
  tranche: string | null
  base: string
}

export type Tranche = { name: string | null; intent?: string; tasks: Task[] }

/** The one object the 3D scene reads. */
export type SceneState = {
  stage: Stage
  tone: Tone
  orbit: boolean
  gates: GateState
  tasks: number
  done: number
  hot: boolean
  milestone: boolean
  closed: boolean
}

export const initialScene: SceneState = {
  stage: 'upstream',
  tone: 'think',
  orbit: false,
  gates: [0, 0, 0],
  tasks: 0,
  done: 0,
  hot: false,
  milestone: false,
  closed: false
}

export type OutputCard =
  | { kind: 'milestone'; name: string; branch: string; intents: string[] }
  | { kind: 'tranche'; tranche: Tranche }
  | { kind: 'issue'; issue: number; title: string; surface: string; hot?: boolean }

/** One scene of a flow: a stage, its copy, and what the reader's scroll types. */
type StepKind = 'intro' | 'chat' | 'exec' | 'archive' | 'improve'

/**
 * A section said the way a landing page says it: the stage, then a few big
 * bullets (how you start it, what it does, what comes out).
 * When a step has one, it replaces the eyebrow, title and text.
 */
export type Brief = {
  /** Stage number shown above the title; absent for a harness feature (Self-improvement), whose header says Built into the harness. */
  n?: number
  title: string
  subtitle?: string
  /** The command that starts it, or 'Automatic'. */
  command: string
  does?: string
  output: string
}

export type Step = {
  brief?: Brief
  kind: StepKind
  stage: Stage
  eyebrow: string
  title: string
  text: string
  /** One bold sentence under the text: the thing the reader must not miss. */
  emphasis?: string
  /** Chat or terminal surface the lines type into. */
  surface?: Surface
  /** Lines the reader's scroll types. For `exec` steps the lines are derived per task. */
  lines?: ChatLine[]
  /** Log events emitted after the lines finish. */
  after?: LogEvent[]
  /** Card revealed when the lines finish. */
  output?: OutputCard
  /** Scene state applied when the lines finish. */
  sceneAfter?: Partial<SceneState>
  /** `exec` steps run the loop for every task of this tranche. */
  tranche?: Tranche
  /** How many of the tranche's tasks the log shows in full; the rest run as one dispatch line and one merge line each. */
  logFull?: number
  /** `archive` and `improve` steps. */
  closingLines?: ChatLine[]
  banner?: { title: string; text: string }
  stats?: { value: string; label: string }[]
  proposals?: { kind: string; title: string; text: string; target: 'Linear' | 'Jira' }[]
  /** The walk's last step: back outside Vinaya, after Self-improvement. Renders like the Upstream intro. */
  outro?: boolean
}

export type Flow = {
  key: FlowKey
  /** The scenario's name: the card's label and the flow menu's entry. */
  label: string
  /** The card title: what the reader deploys. */
  deploy: string
  /** What fits this scenario, in one line. */
  scope: string
  tone: Tone
  /** What the scenario is, as a few short bullets for its choice card. High level only. */
  points: string[]
  /** The tranches this flow executes; `hot` has none. */
  tranches: Tranche[]
  steps: Step[]
  /** Which stages of the map this flow lights, in order. */
  path: string[]
}
