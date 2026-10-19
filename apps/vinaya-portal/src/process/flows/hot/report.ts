/**
 * Hot issue's two ends, as data: the broken thing it starts from and what the
 * Log teaches once it is fixed. Kept in this folder, like Medium work's, so
 * Home and the diagram never read them; the scene and the walk render these
 * same values.
 */

/** The hot Issue's brief, as `vinaya issue create` writes it: the single-fix profile, read by the Principal. */
export const hotBrief: { label: string; value: string }[] = [
  { label: 'Objective', value: 'The CLI test passes on every CI run' },
  { label: 'Surface', value: 'apps/cli/test/tmp.test.ts' },
  { label: 'Test plan', value: '50 runs in a row, 0 failures' },
  { label: 'Readiness', value: 'performed by the Principal' }
]

/** The hot run's figures, as the report shows them. `hot` marks the figure the reader must notice. */
export const hotStats: { value: string; label: string; detail: string; hot?: boolean }[] = [
  { value: '9 min', label: 'time to merge', detail: 'from the Issue to main' },
  { value: '1', label: 'review attempt', detail: 'two reviewers, once, on demand' },
  { value: '3 in 30 days', label: 'hot fixes here', detail: 'all in apps/cli tests', hot: true }
]

/** The last 30 days of hot fixes, by day: the three in apps/cli tests are the pattern. */
export const hotMonth: { day: number; here: boolean }[] = [
  { day: 4, here: true },
  { day: 11, here: false },
  { day: 17, here: true },
  { day: 29, here: true }
]

/** What the Improver reads in the report, and the change it asks for. It is approved. */
export const hotFinding = { found: 'Three hot fixes, one place', change: 'Plan it: every test gets its own temp dir' }

/** The new Project's title: the approved change, said as product would. */
export const hotProposal = 'Isolate test temp dirs'

/** Why the approved change is worth a Project: the report's lines that justify it. */
export const hotWhy: string[] = [
  '3 hot fixes in apps/cli tests in 30 days',
  'Each one blocked every merge on main',
  'Planned once, it stops coming back'
]
