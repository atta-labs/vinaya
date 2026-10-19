/**
 * Complex work's two ends, as data: the product Projects it starts from and what
 * the Log teaches once it is done. The diagram's Self-improvement cards
 * (`StatRow`, `ProposalList`) and the life-cycle animation's last altitudes
 * render these same values, so the two can never disagree.
 */

/** The products the deploy touches: fixed parts of the system, each with its mark. */
export type Product = 'phone' | 'monitor' | 'cloud' | 'server' | 'database' | 'dashboard'

/**
 * The Projects product defined in the tracker for the one target, before Vinaya:
 * features to deliver, each touching one or more products (their marks).
 */
export const checkoutProjects: { name: string; products: Product[] }[] = [
  { name: 'Never charge twice', products: ['cloud', 'server'] },
  { name: 'Ledger and receipts', products: ['database', 'server'] },
  { name: 'Fraud checks at the edge', products: ['cloud'] },
  { name: 'One-tap pay on mobile', products: ['phone', 'server'] },
  { name: 'Checkout on desktop', products: ['monitor', 'server'] },
  { name: 'Refunds in the admin', products: ['dashboard', 'database'] }
]

/**
 * The milestone's parts, one per tranche, in order: each part's name and the
 * Projects (indexes into `checkoutProjects`) it is made from.
 */
export const checkoutParts: { name: string; projects: number[] }[] = [
  { name: 'Charge once', projects: [0, 1, 2] },
  { name: 'Pay in the apps', projects: [3, 4] },
  { name: 'Support tools', projects: [5] }
]

/** The deployment's stats, as the report shows them. `hot` marks the figure the reader must notice. */
export const improveStats: { value: string; label: string; detail: string; hot?: boolean }[] = [
  { value: '34 min', label: 'time per task', detail: 'Developer plus reviewers, median' },
  { value: '19 of 52', label: 'second rounds', detail: 'Reviewers asked for changes' },
  { value: '418', label: 'problems caught', detail: '9 blockers · 71 major, before merge', hot: true },
  { value: '18,508', label: 'checks run', detail: '39 checks · 130 bad changes stopped' }
]

/** Where the time goes, in shares of 100. */
export const timeSplit: { label: string; share: number }[] = [
  { label: 'Developer', share: 84 },
  { label: 'Reviewers', share: 16 }
]

/**
 * What the Improver reads in the report, and the change each finding asks for.
 * The first change is the one approved and sent back to product.
 */
export const improveFindings: { found: string; change: string }[] = [
  { found: 'Most extra rounds come from one gate', change: 'Run the doc gate before push' },
  { found: 'A vague Surface doubles the rounds', change: 'Check the Surface at planning time' },
  { found: 'Rulings are hard to predict', change: 'Preview a resume in Studio' }
]

/** The diagram's StatRow line. */
export const improveConclusions: string[] = improveFindings.slice(0, 2).map((f) => f.found)

/** Why the approved change is worth a Project: the report's lines that justify it. */
export const improveWhy: string[] = [
  '19 of 52 tasks needed a second round',
  'Most of those failed the same gate',
  'Expected: 0.7 fewer rounds per task'
]

/** The projects the Improver drafts from them. The first is the one approved. */
export const improveProposals: { title: string; kind: string; text: string }[] = [
  { title: 'Run the doc gate before push', kind: 'Fix', text: 'cuts an expected 0.7 rounds per task' },
  { title: 'Surface check at planning time', kind: 'Fix', text: 'catches vague briefs before dispatch' },
  { title: 'Resume preview in Studio', kind: 'New feature', text: 'shows what a ruling will change' }
]
