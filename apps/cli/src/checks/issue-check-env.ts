/**
 * Shared env-reading for every `validates: 'issue'` check bin (task 17, O2).
 * `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks` sets these once, from
 * facts it already resolved, rather than having each bin independently
 * re-fetch the same forge state its caller already has in hand.
 *
 * Every field is absence-tolerant (`''`/`null`) — a bin invoked directly
 * (`vinaya check issue-tranche-label`) with no Issue write in flight has
 * nothing to grade and takes its own documented "nothing to do" bypass.
 */
export type IssueCheckEnv = {
  body: string
  labels: string[]
  title: string | null
  issueNumber: number | null
  currentMilestoneTitle: string | null
  resolvedMilestoneTitle: string | null
}

function nullIfEmpty(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null
}

export function readIssueCheckEnv(env: NodeJS.ProcessEnv = process.env): IssueCheckEnv {
  const labelsRaw = env.ISSUE_LABELS ?? ''
  const issueNumberRaw = env.ISSUE_NUMBER ?? ''
  const parsedIssueNumber = Number.parseInt(issueNumberRaw, 10)
  return {
    body: env.ISSUE_BODY ?? '',
    labels: labelsRaw.length > 0 ? labelsRaw.split(',').filter(Boolean) : [],
    title: nullIfEmpty(env.ISSUE_TITLE),
    issueNumber: Number.isInteger(parsedIssueNumber) ? parsedIssueNumber : null,
    currentMilestoneTitle: nullIfEmpty(env.CURRENT_MILESTONE_TITLE),
    resolvedMilestoneTitle: nullIfEmpty(env.RESOLVED_MILESTONE_TITLE)
  }
}
