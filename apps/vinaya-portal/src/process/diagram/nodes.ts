import type { Brand } from '../components/BrandIcon'
import type { FlowKey, Stage, Tone } from '../types'

/**
 * The process diagram as data. Layout is a grid, not coordinates: every card
 * is a `DiagramCard`, every stage label a `DiagramBand`, every arrow a
 * `Connector` measured from the rendered cards. Each node says which flows it
 * belongs to and at which stage it becomes current; `./moment.ts` turns that
 * into a visual state.
 */
export type DiagramTone = Tone | 'neutral'

export type DiagramMock =
  | { kind: 'tasks'; label: string; tag: string; items: string[] }
  | { kind: 'issue'; n: string; tag: string; title: string }
  | { kind: 'chat' }
  | { kind: 'loops' }
  | { kind: 'events' }
  | { kind: 'stats' }
  | { kind: 'proposals' }

export type DiagramNode = {
  id: string
  tone: DiagramTone
  title: string
  /** Secondary lines; a line starting with `#` renders mono. */
  lines?: string[]
  /** Small mono label on the right of the title. */
  tag?: string
  /** Flows this node takes part in. `all` = every flow. Empty = never (covered). */
  flows: FlowKey[] | 'all'
  /** Stage at which the node is current; `always` for the observed column. */
  at: Stage | 'always'
  dashed?: boolean
  /** A brand mark before the title. */
  icon?: Brand
  /** A lucide icon before the title, by name. */
  lucide?: 'laptop'
  /** Compact: title and tag on one line, no body. */
  compact?: boolean
  mock?: DiagramMock
}

type DiagramBand = { id: string; label: string; tone: DiagramTone }

type Side = 'top' | 'bottom' | 'left' | 'right'
export type DiagramEdge = {
  id: string
  from: string
  to: string
  fromSide?: Side
  toSide?: Side
  tone?: Tone
  flows?: FlowKey[] | 'all'
  dashed?: boolean
  /** `straight`: one diagonal line between the anchors instead of an orthogonal route. */
  shape?: 'route' | 'straight'
}

const N = (n: DiagramNode) => n
const planned: FlowKey[] = ['feature', 'medium', 'backlog']

export const nodes: Record<string, DiagramNode> = {
  linear: N({
    id: 'linear',
    icon: 'linear',
    tone: 'product',
    title: 'Linear',
    lines: [
      'Initiative → Project → Project milestone → Issue',
      'Project = the specced feature',
      'Teams own Issues; Cycles time-box them'
    ],
    flows: ['feature'],
    at: 'upstream'
  }),
  jira: N({
    id: 'jira',
    icon: 'jira',
    tone: 'product',
    title: 'Jira',
    lines: [
      'Initiative → Epic → Story / Task / Bug → Sub-task',
      'Epic = the specced feature · Release (Fix version)',
      'Jira Project = container, like a Linear Team · Sprints'
    ],
    flows: ['feature'],
    at: 'upstream'
  }),
  need: N({
    id: 'need',
    tone: 'product',
    title: 'Engineering need',
    lines: ['No product project behind it:', 'tech debt, orchestration fixes,', 'bugs found while working'],
    flows: ['medium', 'backlog', 'hot'],
    at: 'upstream'
  }),

  architect: N({
    id: 'architect',
    tone: 'think',
    title: 'Architect',
    lines: ['Execution Milestone: code direction', '+ tranche intents (drafts)', '#⎇ milestone integration branch'],
    flows: ['feature'],
    at: 'architect'
  }),
  'planner-tranche': N({
    id: 'planner-tranche',
    tone: 'think',
    title: 'Planner · per tranche',
    lines: ['Reads real specs + real code,', 'materialises intent into tasks', '#⎇ tranche branch → milestone branch'],
    flows: ['feature'],
    at: 'planner',
    mock: { kind: 'tasks', label: 'TR-02', tag: 'planned', items: ['#418', '#419', '#420', '#421'] }
  }),
  'planner-standalone': N({
    id: 'planner-standalone',
    tone: 'think',
    title: 'Planner · standalone tranche',
    lines: ['Multi-task internal need,', 'no Milestone above it', '#⎇ optional tranche branch'],
    flows: ['medium'],
    at: 'planner',
    mock: { kind: 'tasks', label: 'TR-07', tag: 'planned', items: ['#610', '#611', '#612', '#613'] }
  }),
  'planner-backlog': N({
    id: 'planner-backlog',
    tone: 'think',
    title: 'Planner · backlog Issue',
    lines: ['One-off found while working;', 'or added to an open tranche', '#lighter planning, no tranche'],
    flows: ['backlog'],
    at: 'planner',
    mock: { kind: 'issue', n: '#1000', tag: 'backlog', title: 'Resume refuses kept work' }
  }),
  'hot-issue': N({
    id: 'hot-issue',
    tone: 'hot',
    title: 'Hot Issue',
    lines: ['No planner. Issue opened hot,', 'light brief', '#same gates, still recorded'],
    flows: ['hot'],
    at: 'architect',
    dashed: true,
    mock: { kind: 'issue', n: '#1001', tag: 'hot', title: 'Fix flaky CLI test now' }
  }),
  'planned-bar': N({
    id: 'planned-bar',
    tone: 'think',
    title:
      'Planned tasks: each an Issue with a brief (Surface, objectives, test plan) — the contract the loop executes',
    flows: planned,
    at: 'planner',
    dashed: true,
    compact: true
  }),

  loop: N({
    id: 'loop',
    tone: 'exec',
    title: 'Developer–Review Loop',
    tag: 'DRIVEN BY THE OPERATOR',
    flows: planned,
    at: 'loop'
  }),
  driver: N({
    id: 'driver',
    tone: 'exec',
    title: 'dev-review-loop.ts',
    tag: 'sends the work, reads the result, decides the next step',
    lines: ['#MULTI-AGENT ORCHESTRATION · THE DRIVER'],
    flows: planned,
    at: 'loop'
  }),
  developer: N({
    id: 'developer',
    tone: 'exec',
    title: 'Developer agent',
    lines: ['implements the brief'],
    flows: planned,
    at: 'loop'
  }),
  reviewers: N({
    id: 'reviewers',
    tone: 'exec',
    title: 'Reviewer agents',
    lines: ['judge it against its Surface and objectives'],
    flows: planned,
    at: 'loop'
  }),
  engine: N({
    id: 'engine',
    icon: 'langgraph',
    tone: 'exec',
    title: 'Atta Engine · LangGraph runtime',
    tag: 'CHECKPOINTS · HALT AND RESUME · RECOVERY',
    flows: planned,
    at: 'loop',
    compact: true
  }),
  'rt-claude': N({
    id: 'rt-claude',
    icon: 'claude',
    tone: 'exec',
    title: 'Claude Code',
    tag: 'SANDBOXED',
    flows: 'all',
    at: 'loop',
    compact: true
  }),
  'rt-codex': N({
    id: 'rt-codex',
    icon: 'codex',
    tone: 'exec',
    title: 'Codex',
    tag: 'SANDBOXED',
    flows: 'all',
    at: 'loop',
    compact: true
  }),
  'rt-mac': N({
    id: 'rt-mac',
    icon: 'apple',
    tone: 'exec',
    title: 'macOS',
    tag: 'sandbox: Seatbelt',
    flows: 'all',
    at: 'loop',
    compact: true
  }),
  'rt-linux': N({
    id: 'rt-linux',
    icon: 'linux',
    tone: 'exec',
    title: 'Linux / Unix',
    tag: 'sandbox: seccomp',
    flows: 'all',
    at: 'loop',
    compact: true
  }),
  'hot-mode': N({
    id: 'hot-mode',
    tone: 'hot',
    title: 'Hot Mode',
    tag: 'DEV + ONE AGENT',
    lines: [
      '#DIRECT CHAT · LIGHT BRIEF · DEV DRIVES',
      '#ANY CHAT SURFACE',
      'CLI · desktop app · IDE',
      'No loop, no engine.',
      "Sandbox is the agent's own setting.",
      'The gates still apply.'
    ],
    flows: ['hot'],
    at: 'loop',
    dashed: true,
    mock: { kind: 'chat' }
  }),

  ring0: N({
    id: 'ring0',
    lucide: 'laptop',
    tone: 'exec',
    title: 'Ring 0 · commit + push hooks',
    lines: ['last door before GitHub'],
    flows: 'all',
    at: 'loop'
  }),
  ring1: N({
    id: 'ring1',
    icon: 'github',
    tone: 'exec',
    title: 'Ring 1 · CI on the PR',
    lines: ['same checks, merge blocked while red'],
    flows: 'all',
    at: 'loop'
  }),
  ring2: N({
    id: 'ring2',
    icon: 'github',
    tone: 'exec',
    title: 'Ring 2 · audits',
    lines: ['after merge, always on'],
    flows: 'all',
    at: 'loop'
  }),

  replan: N({
    id: 'replan',
    tone: 'exec',
    title: 'Brief no longer fits? → Replan',
    lines: [
      'Pause affected work. The Planner repairs',
      'the plan: brief, dependencies, conflicts.',
      'Nothing runs on a stale brief.',
      '#↻ BACK TO THINKING → EXECUTING'
    ],
    flows: [],
    at: 'loop'
  }),
  recover: N({
    id: 'recover',
    tone: 'exec',
    title: 'Interrupted or stuck? → Recover',
    lines: [
      'Execution stops at an explicit pause',
      'that names who must act.',
      'A ruling is posted; the loop resumes',
      'from the record, not from memory.',
      '#↻ BACK TO EXECUTING'
    ],
    flows: [],
    at: 'loop'
  }),
  merge: N({
    id: 'merge',
    tone: 'exec',
    title: 'Ready? → Review and merge',
    lines: [
      'Gates green on the pull request.',
      'Required reviews report.',
      'The Principal merges. Nobody else does.',
      '#MERGED → ARCHIVE · REFUSED → EXECUTE / REPLAN'
    ],
    flows: 'all',
    at: 'merge'
  }),

  archivist: N({
    id: 'archivist',
    tone: 'exec',
    title: 'Archivist',
    lines: ['Closes each task on merge', 'Records what shipped and why'],
    flows: 'all',
    at: 'archive'
  }),
  'tranche-archivist': N({
    id: 'tranche-archivist',
    tone: 'exec',
    title: 'Tranche Archivist',
    lines: ['Closes the tranche when its last task lands'],
    flows: ['feature', 'medium'],
    at: 'archive'
  }),
  'milestone-close': N({
    id: 'milestone-close',
    tone: 'exec',
    title: 'Milestone close',
    lines: ['When its tranches have closed'],
    flows: ['feature'],
    at: 'archive'
  }),
  record: N({
    id: 'record',
    tone: 'exec',
    title: 'Retrospective record',
    lines: ['What shipped and why'],
    flows: 'all',
    at: 'archive'
  }),

  stats: N({
    id: 'stats',
    tone: 'hot',
    title: 'Report: what the Log says',
    lines: ['Written from every run of the deploy. Example figures.'],
    flows: 'all',
    at: 'improve',
    mock: { kind: 'stats' }
  }),
  improver: N({
    id: 'improver',
    tone: 'hot',
    title: 'Improver',
    lines: ['Reads the report, proposes what to change', '#BACK TO LINEAR / JIRA · THE PRINCIPAL APPROVES'],
    flows: 'all',
    at: 'improve',
    mock: { kind: 'proposals' }
  }),

  log: N({
    id: 'log',
    icon: 'cloudflare',
    tone: 'log',
    title: 'The Log',
    lines: [
      'Every plan, loop round, gate, review, hot commit and archive.',
      'Typed, attributed, live, from the first Issue.',
      '#{logServer} · CONFIGURABLE'
    ],
    flows: 'all',
    at: 'always',
    mock: { kind: 'events' }
  }),
  studio: N({
    id: 'studio',
    tone: 'log',
    title: 'Studio · Mission Control',
    lines: [
      'Reads the Log live. Every loop, every round, every hot commit.',
      '#NOTHING RUNS UNRECORDED · PLANNED, BACKLOG AND HOT ALIKE'
    ],
    flows: 'all',
    at: 'always',
    mock: { kind: 'loops' }
  })
}

export const bands = {
  product: {
    id: 'product',
    label: 'OUTSIDE VINAYA · PRODUCT MANAGEMENT · defines the what, hands specs to engineering',
    tone: 'product'
  },
  stage1: { id: 'stage1', label: 'STAGE 1 · THINKING · architect and planner', tone: 'think' },
  stage2: {
    id: 'stage2',
    label: 'STAGE 2 · EXECUTING AND RETROSPECTING · the loop, the gates, closure and the record: all automatic',
    tone: 'exec'
  },
  gates: {
    id: 'gates',
    label: 'GATES · at every step, the doors to GitHub · same for planned and hot · cannot be skipped',
    tone: 'exec'
  },
  closure: { id: 'closure', label: 'BEFORE CLOSURE · REPLAN, RECOVER, MERGE', tone: 'exec' },
  stage3: { id: 'stage3', label: 'RETROSPECTING · on every merge, automatic', tone: 'exec' },
  stage4: { id: 'stage4', label: 'STAGE 4 · SELF-IMPROVEMENT · the Log teaches the process', tone: 'hot' },
  observe: { id: 'observe', label: 'OBSERVABILITY & AUDITABILITY', tone: 'log' }
} satisfies Record<string, DiagramBand>

/** A band by an id that may name a card instead. */
export const bandById: Record<string, DiagramBand | undefined> = bands

const E = (
  id: string,
  from: string,
  to: string,
  flows: DiagramEdge['flows'] = 'all',
  extra: Partial<DiagramEdge> = {}
): DiagramEdge => ({ id, from, to, flows, ...extra })
const observe = (id: string, from: string, flows: DiagramEdge['flows'] = 'all'): DiagramEdge => ({
  id,
  from,
  to: 'observe',
  fromSide: 'right',
  toSide: 'left',
  flows,
  tone: 'log',
  dashed: true
})

/** Containers that edges can connect: each stage frame, by band id, with the stage it is current at. */
export const stageAt: Record<string, Stage | 'always'> = {
  product: 'upstream',
  stage1: 'planner',
  stage2: 'loop',
  gates: 'loop',
  closure: 'merge',
  stage3: 'archive',
  stage4: 'improve',
  observe: 'always'
}

export const edges: DiagramEdge[] = [
  // between stages: container to container, so no arrow crosses a label
  E('product-stage1', 'product', 'stage1', 'all', { shape: 'straight' }),
  E('stage1-stage2', 'stage1', 'stage2', 'all', { shape: 'straight' }),
  E('gates-closure', 'gates', 'closure', 'all', { shape: 'straight' }),
  E('closure-stage3', 'closure', 'stage3', 'all', { shape: 'straight' }),
  // Gates, closure and retrospecting sit inside the Executing container: chained inside it, and the container hands on to stage 4.
  E('stage2-stage4', 'stage2', 'stage4', 'all', { shape: 'straight' }),
  E('back-to-product', 'stage4', 'product', 'all', { fromSide: 'left', toSide: 'left', tone: 'hot', dashed: true }),
  // inside stage 1 (the planned-tasks bar sits under the planners; no arrow needed)
  E('arch-plan', 'architect', 'planner-tranche', ['feature'], { shape: 'straight' }),
  // inside stage 2
  E('driver-dev', 'driver', 'developer', planned, { tone: 'exec', shape: 'straight', dashed: true }),
  E('driver-rev', 'driver', 'reviewers', planned, { tone: 'exec', shape: 'straight', dashed: true }),
  // inside stage 3 and 4
  E('arch-tranche', 'archivist', 'tranche-archivist', ['feature', 'medium'], { fromSide: 'right', toSide: 'left' }),
  E('tranche-milestone', 'tranche-archivist', 'milestone-close', ['feature'], { fromSide: 'right', toSide: 'left' }),
  E('stats-improver', 'stats', 'improver', 'all', { fromSide: 'right', toSide: 'left' }),
  // every stage writes to the Log
  observe('o-think', 'stage1'),
  observe('o-exec', 'stage2'),
  observe('o-improve', 'stage4'),
  E('log-studio', 'log', 'studio', 'all', { tone: 'log' })
]
