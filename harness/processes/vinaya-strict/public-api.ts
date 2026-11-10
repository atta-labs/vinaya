/**
 * The process's library entry: what `@attalabs/vinaya/process` exposes to a
 * consumer. Each symbol is named, never re-exported with `export *`, so the
 * public surface is exactly this list.
 */
export { checkLocalAnchorCoverage } from './checks/local-anchor-coverage'
export type { AnchorSourceFile } from './checks/local-anchor-coverage'
export { scanRetiredVocabulary } from './checks/retired-vocabulary'
export { evaluateVocabularyCitation } from './checks/vocabulary-citation'
export type { VocabularyHit, VocabularyPattern } from './checks/vocabulary-citation'
export { COMMIT_TYPE_STYLE } from './tools/task-contract/brief-validation'
