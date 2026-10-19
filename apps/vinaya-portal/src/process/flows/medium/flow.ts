import { archiveStep, foldArchive, intro, T } from '../../fixtures/builders'
import type { ChatLine, Flow, Task, Tranche } from '../../types'
import { INTEGRATION } from './report'
import { improverReportChat, operatorLines, plannerChat } from './scripts'

/* Medium work: one Epic, Gift cards, in the shop repo. One standalone tranche, no
   milestone; its twelve tasks run in three waves set by their dependencies, each
   wave tested together on the integration branch, then merged to main. */
const task = (issue: number, n: number, title: string, file: string) =>
  T(issue, n, title, file, 'gift-cards/1', INTEGRATION)

/** The tranche's tasks by wave, in the order they run: data, then the API, then the apps. */
export const giftCardWaves: Task[][] = [
  [
    task(512, 1, 'Gift card table', 'db/gift_cards.sql'),
    task(513, 2, 'Balance ledger', 'db/gc_ledger.sql'),
    task(517, 3, 'Code generator', 'api/giftcards/codes.ts')
  ],
  [
    task(514, 4, 'Issue a card', 'api/giftcards/issue.ts'),
    task(515, 5, 'Redeem at checkout', 'api/giftcards/ledger.ts'),
    // the same file as #515: it runs after it
    task(516, 6, 'Partial balance', 'api/giftcards/ledger.ts'),
    task(518, 7, 'Fraud limits', 'edge/gc-limits.ts')
  ],
  [
    task(519, 8, 'Buy a card on mobile', 'mobile/GiftCard.tsx'),
    task(520, 9, 'Wallet on mobile', 'mobile/Wallet.tsx'),
    task(521, 10, 'Redeem on desktop', 'desktop/redeem.ts'),
    task(522, 11, 'Gift card email', 'api/giftcards/email.ts'),
    task(523, 12, 'Admin lookup', 'admin/giftcards.tsx')
  ]
]

const giftCards: Tranche = {
  name: 'gift-cards/1',
  intent: 'Gift cards: one Epic, one standalone tranche, base main. No milestone.',
  tasks: giftCardWaves.flat()
}

const range = (tr: Tranche) => `#${tr.tasks[0]?.issue}–#${tr.tasks[tr.tasks.length - 1]?.issue}`

/** The tranche's closure, one line each: its Issues, the tranche, the Epic. */
const closing: ChatLine[] = [
  { kind: 'hl', text: '── the tranche closes ──' },
  {
    kind: 'ok',
    text: `${giftCards.name} · ${giftCards.tasks.length} Issues closed · ${range(giftCards)}`,
    effect: {
      log: giftCards.tasks.map((t) => ({
        name: 'forge_write.written',
        detail: `op=archive · #${t.issue}`,
        tone: 'retro' as const
      }))
    }
  },
  {
    kind: 'ok',
    text: `${giftCards.name} archived`,
    effect: {
      log: [{ name: 'forge_write.written', detail: `op=archive · tranche ${giftCards.name}`, tone: 'retro' }]
    }
  },
  {
    kind: 'ok',
    text: '{project} Gift cards done in {tracker}',
    effect: { log: [{ name: 'forge_write.written', detail: 'op=epic.done · Gift cards', tone: 'retro' }] }
  }
]

/** Medium work: one feature or project, many agents in parallel, one standalone tranche. */
export const mediumFlow: Flow = foldArchive({
  key: 'medium',
  label: 'Medium work',
  deploy: 'Deploy medium work',
  scope: 'Complex features, fixes or refactors',
  tone: 'think',
  points: [
    'One feature or project',
    'Many agents in parallel',
    'Integrated on main',
    'Tested on an integration branch'
  ],
  tranches: [giftCards],
  path: ['upstream', 'planner', 'loop', 'gates', 'merge', 'archive', 'observed', 'improve'],
  steps: [
    intro({
      title: 'One feature,\none {project} in {tracker}.',
      text: 'Gift cards, defined by product. It ships on its own, as fast as parallel agents allow, without breaking main.'
    }),
    {
      kind: 'chat',
      stage: 'planner',
      eyebrow: 'Stage 1 · Thinking · Planner',
      title: 'Planning',
      text: '',
      brief: {
        n: 1,
        title: 'Planning',
        command: '/vinaya planner',
        does: 'Cut the {project} into tasks agents can run in parallel',
        output: '12 tasks in one tranche, in 3 waves'
      },
      surface: 'claude',
      lines: plannerChat(giftCards)
    },
    {
      kind: 'exec',
      stage: 'loop',
      eyebrow: 'Stage 2 · Executing',
      title: 'Executing',
      text: '',
      brief: {
        n: 2,
        title: 'Executing',
        command: '/vinaya operator',
        does: 'Run each wave in parallel: an agent builds every task, two fresh reviewers check, every gate runs, the wave is tested together before it lands',
        output: '12 reviewed pull requests on main, the {project} done'
      },
      surface: 'terminal',
      // its own lines, no `tranche`: the first task in full, then the three waves (stepLines reads them through linesFor)
      lines: operatorLines(giftCardWaves, INTEGRATION)
    },
    // folded into Executing: its closing lines type on in the same terminal after the last merge
    archiveStep('your tranche', closing, '', ''),
    {
      // a chat, not an `improve` step: the report and its findings are the scene's, so no cards under the window
      kind: 'chat',
      stage: 'improve',
      eyebrow: 'Stage 4 · Self-improvement',
      title: 'The Log teaches the process.',
      text: '',
      brief: {
        n: 4,
        title: 'Self-improvement',
        subtitle: 'The Log teaches the process',
        command: 'Automatic',
        does: 'The Log turns the run into a report. The Improver reads it and proposes what to change',
        output: 'A new {project} in {tracker}, with its report'
      },
      surface: 'claude',
      lines: improverReportChat
    },
    {
      kind: 'intro',
      stage: 'upstream',
      outro: true,
      eyebrow: 'Upstream · outside Vinaya',
      title: 'A new {project} in {tracker}, with its report.',
      text: 'The change the Log asked for goes back to product. The next {project} starts from here.'
    }
  ]
})
