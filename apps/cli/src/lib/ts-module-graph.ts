/**
 * The test selector's compiler-resolved import/export graph. The one
 * implementation lives in the selection library (`verification/compiler-graph.ts`);
 * this path forwards to it unchanged so every existing caller keeps its import.
 */
export {
  ALL_PREFIX,
  buildCompilerGraph,
  type CompilerGraph,
  EXTERNAL_PREFIX,
  type GraphInput,
  loadTypeScript,
  NAME_PREFIX,
  NAME_SEPARATOR,
  OWN_PREFIX,
  PKGMETA_PREFIX,
  SCAN_PREFIX,
  type SourceHost,
  TOUCH_PREFIX,
  type TypeScriptApi
} from './verification/compiler-graph.js'
