/**
 * Changed-name attribution for the test selector. The one implementation lives
 * in the selection library (`verification/changed-names.ts`); this path
 * forwards to it unchanged so every existing caller keeps its import.
 */
export {
  ALL_NAMES,
  affectedNames,
  affectedNamesForFile,
  type FileAffection,
  type FileDiff,
  type LineRange,
  lineDiffRanges,
  parseHunkRanges
} from './verification/changed-names.js'
