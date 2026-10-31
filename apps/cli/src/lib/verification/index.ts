/**
 * The selection library's public entrypoint — the one contract its consumers
 * import. {@link selectTests} answers which tests a change between two
 * committed revisions requires; the rest is what a consumer needs to call it:
 * repository readers, inventory validation, and the public types.
 *
 * See `README.md` beside this file for usage and dependencies.
 */
export { ALL_NAMES, affectedNamesForFile, type FileDiff, lineDiffRanges, parseHunkRanges } from './changed-names.js'
export { loadLibraryTypeScript, type TypeScriptApi } from './compiler-graph.js'
export {
  changedInputReaders,
  DECLARATION_LISTS,
  declarationListProblems,
  diffTestIdentities,
  edgeCovers,
  stableHash,
  stableJson,
  validateInventory,
  validateInventoryView
} from './inventory.js'
export { globRegex, globToRegex, inputCovers, underDeclaredRoot } from './path-pattern.js'
export { type ScannerDeclaration, type ScannerTrigger, scannerTriggered } from './scanner-inputs.js'
export {
  diskTree,
  gitRepository,
  memoryRepository,
  plannedTests,
  revisionTree,
  SELECTION_ENGINE,
  SelectionInputError,
  type SourceTree,
  selectTests
} from './selector.js'
export type { SpawnProgram } from './spawn-inputs.js'
export type {
  EdgeKind,
  FallbackScope,
  FormatParsers,
  InputChange,
  InputFormat,
  InputImpact,
  InventoryProblem,
  InventoryView,
  NativeRunner,
  PlannedChange,
  PlannedObligation,
  PlannedTest,
  PlanReason,
  PolicyDeclaration,
  ReaderKind,
  RepositoryReader,
  ReproductionContext,
  ResolvedEdge,
  SelectionInventory,
  SelectionObligation,
  SelectionPlan,
  SelectionPolicy,
  SelectTestsInput,
  SuiteConfiguration,
  SuiteFacts,
  TestIdentity,
  UnknownScope
} from './types.js'
