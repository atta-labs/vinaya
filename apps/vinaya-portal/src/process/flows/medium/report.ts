/**
 * Medium work's two ends, as data: the one Epic it starts from and what the Log
 * teaches once it is done. Kept in this folder, like Complex work's
 * (`fixtures/lifecycle.ts`), so Home and the diagram never read them; the scene
 * and the walk render these same values.
 */

/** The Epic product defined in the tracker: its key number, its name, the products it touches. */
export const giftCardsEpic = {
  n: 212,
  name: 'Gift cards',
  products: ['database', 'server', 'phone', 'monitor', 'dashboard']
}

/** The integration branch each wave is tested on together before it lands on main. */
export const INTEGRATION = 'integration/gift-cards'

/** What each wave is made of, in the order they run. */
export const waveNames = ['data', 'API', 'apps']

/** The delivery's stats, as the report shows them. `hot` marks the figure the reader must notice. */
export const mediumStats: { value: string; label: string; detail: string; hot?: boolean }[] = [
  { value: '27 min', label: 'time per task', detail: 'Developer plus reviewers, median' },
  { value: '3 of 12', label: 'second rounds', detail: 'Reviewers asked for changes' },
  { value: '31%', label: 'agent time idle', detail: "waiting on a wave's slowest task", hot: true },
  { value: '4,272', label: 'checks run', detail: '64 problems caught before merge' }
]

/**
 * Where each wave's time goes, in shares of the whole run: when it starts
 * (`lead`), how long its agents work, and how long they sit idle waiting on the
 * wave's slowest task.
 */
export const waveTime: { lead: number; work: number; idle: number }[] = [
  { lead: 0, work: 22, idle: 6 },
  { lead: 28, work: 20, idle: 16 },
  { lead: 64, work: 27, idle: 9 }
]

/** What the Improver reads in the report, and the change each finding asks for. The first is approved. */
export const mediumFindings: { found: string; change: string }[] = [
  { found: 'Waves wait on their slowest task', change: 'Start each task when its own dependencies merge' },
  { found: 'Two tasks shared one file', change: 'Split shared files at planning time' },
  { found: 'Second rounds cluster on the API', change: 'Put a contract test in API briefs' }
]

/** Why the approved change is worth an Epic: the report's lines that justify it. */
export const mediumWhy: string[] = [
  'Agents sat idle 31% of the run',
  'Wave 2 waited 22 min on #515',
  'Expected: the run ends 18 min sooner'
]
