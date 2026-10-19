/**
 * The status of every docs page that is not simply shipped. One list, reviewed
 * each release. A page missing from here is Shipped.
 *
 * - Planned: defined in Linear, not in the released package.
 * - Partial: part of the page is shipped; the page says which part is not.
 * - Draft: the page states a rule Linear still lists as an open Principal decision.
 */
type DocsStatus = 'Planned' | 'Partial' | 'Draft'

export const DOCS_STATUS: Record<string, DocsStatus> = {
  '/docs/features/self-improvement': 'Planned',
  '/docs/features/studio/mission-control': 'Planned',
  '/docs/features/studio/many-repositories': 'Planned',
  '/docs/features/studio/dashboard-and-statistics': 'Partial',
  '/docs/dev-process/loader': 'Planned',
  '/docs/dev-process/conformance': 'Partial',
  '/docs/process/integration/loader': 'Planned',
  '/docs/process/integration/conformance': 'Planned',
  '/docs/process/integration/logging': 'Partial',
  '/docs/process/executing/batches': 'Planned',
  '/docs/process/events': 'Partial',
  '/docs/process/thinking/issue-kinds': 'Draft',
  '/docs/process/executing/hot-mode': 'Draft',
  '/docs/process/executing/parent-and-integration-branches': 'Draft',
  '/docs/process/guides/from-one-issue': 'Draft',
  '/docs/process/guides/hot-issue': 'Planned'
}
