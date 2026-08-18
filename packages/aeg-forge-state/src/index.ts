export { amendRationaleDeps } from './amend-rationale-deps'
export type { AmendDepsInput } from './amend-rationale-deps'
export { deriveTrancheFromForge, trancheFromIssues } from './derive-from-forge'
export {
  findMilestoneForSlug,
  indexTrancheMilestonesAsync,
  listActiveTrancheSlugs,
  listActiveTrancheSlugsAsync,
  listArchivedTrancheSlugs,
  listArchivedTrancheSlugsAsync
} from './fetch-milestone'
export type { ActiveTrancheRef, MilestoneFacts, TrancheMilestoneIndex } from './fetch-milestone'
export type { GhIssue } from './gh'
export { fetchProvenance } from './fetch-provenance'
export { buildBranchName, fetchForgeFacts, fetchForgeTasksByLabel } from './fetch-forge-facts'
export { fetchOpenIssuesByLabel } from './fetch-open-issues'
export { fetchTaskIssueRefs } from './fetch-task-issue-refs'
export {
  findTrancheSlug,
  hasLabel,
  trancheLabel,
  trancheSlugLengthError,
  trancheSlugOf,
  LABEL_MAX_LENGTH,
  LABEL_NAMESPACE,
  LABELS,
  label,
  matchesLabel
} from './labels'
export type { Label, LabelCategory, LabelForm, LabelKey } from './labels'
export { AEG_BLOCKED_LABEL, mapForgeFacts } from './map-forge-facts'
export { resolveGithubToken } from './github-token'
export { issueMilestonesFromIssues, listIssueMilestonesForSlug } from './list-issue-milestones'
export type { IssueMilestoneFact } from './list-issue-milestones'
export {
  fetchTrancheIssuesAsync,
  listTasksForSlug,
  listTasksForSlugAsync,
  projectFieldFromBody,
  projectsFromBody,
  resolveTaskIssueRef,
  tasksFromIssues,
  TITLE_PATTERN
} from './list-tasks'
export type { ProjectField } from './list-tasks'
// `stripCode` is on the barrel because `aeg-core` re-exports it as public API.
// `maskCode` and `hasUnterminatedFence` are NOT: they are reachable through the
// `./strip-code` subpath for the two callers that need them, so moving the
// grammar down a layer does not widen this published package's front door.
export { stripCode } from './strip-code'
export type { StripCodeOptions } from './strip-code'
export { parseRationaleDeps, SECTION_HEADER } from './parse-rationale-deps'
export type { ParsedRationaleDeps } from './parse-rationale-deps'
export { resolveRepo } from './resolve-repo'
export type { RepoRef } from './resolve-repo'
