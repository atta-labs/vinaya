#!/usr/bin/env bun
/**
 * Bundles the CLI into a single Node-executable ESM file: dist/index.js —
 * AND each `src/checks/bin/*.ts` core check into its own standalone,
 * self-contained `dist/checks/bin/*.js`.
 *
 * The second half exists because `package.json`'s `files` allowlist ships
 * only `dist`, `templates`, `README.md` — `src/` never reaches the
 * published tarball. `registry.ts`'s `CheckSpec.run` entries used to point
 * straight at `src/checks/bin/*.ts`, which worked in every local/monorepo
 * context (the source is right there) and was 100% broken in the real
 * published package (`vinaya check --all` errored "not found on PATH" for
 * all 15 registered checks — found live against `@attalabs/vinaya@0.1.1`).
 * Each check now gets the exact same bundling treatment as the main CLI
 * entrypoint, so what ships is what actually runs.
 *
 * - `--target=node`: the published artifact must run on a machine that has
 *   only Node — npx/pnpm dlx/yarn dlx are package-manager invocations, not
 *   runtime choices.
 * - Externals are DERIVED from the manifest, never hand-written: every
 *   declared dependency whose specifier is not `workspace:*` stays external
 *   (it ships as a real npm dependency); the whole `@atta/*` workspace graph
 *   is inlined. Adding a real dependency later can therefore never be
 *   silently inlined. Same external list for both builds — the checks import
 *   the process, no dependency the main entrypoint doesn't already have.
 * - Output is a single-level `dist/` for the main entrypoint —
 *   `readVersion()` in src/index.ts resolves `..` from the emitted file and
 *   must land on the package root. Check bins nest one level deeper
 *   (`dist/checks/bin/`), mirroring their source layout exactly, so
 *   `registry.ts`'s `packageRoot()`-relative resolution needs no special
 *   casing between the two.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROGRAMS } from '../../../harness/processes/vinaya-strict/tools/programs.js'

const pkgRoot = join(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>
}

const external = Object.entries(pkg.dependencies ?? {})
  .filter(([, spec]) => !spec.startsWith('workspace:'))
  .map(([name]) => name)

/** The bin contract every emitted entrypoint carries: a Node shebang, executable. Bun preserves the source file's own shebang, but normalize anyway so the artifact never depends on bundler behavior. */
function normalizeExecutable(outFile: string): void {
  const bundled = readFileSync(outFile, 'utf-8')
  const shebang = '#!/usr/bin/env node'
  const body = bundled.startsWith('#!') ? bundled.slice(bundled.indexOf('\n') + 1) : bundled
  writeFileSync(outFile, `${shebang}\n${body}`)
  chmodSync(outFile, 0o755)
}

async function build(entrypoints: string[], outdir: string): Promise<void> {
  // `naming: '[name].[ext]'` — flat by basename only. Bun's default naming
  // template includes `[dir]`, computed relative to the entrypoints' common
  // ancestor rather than each file's own directory; for a multi-entrypoint
  // build that ancestor sits ABOVE `checkBinDir`, so the default silently
  // nests output as `outdir/src/checks/bin/*.js` instead of `outdir/*.js`.
  const result = await Bun.build({
    entrypoints,
    outdir,
    target: 'node',
    format: 'esm',
    external,
    naming: '[name].[ext]'
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}

await build([join(pkgRoot, 'src', 'index.ts')], join(pkgRoot, 'dist'))
normalizeExecutable(join(pkgRoot, 'dist', 'index.js'))

const processChecksDir = join(pkgRoot, '..', '..', 'harness', 'processes', 'vinaya-strict', 'checks')
const checkBinDir = join(processChecksDir, 'bin')
const checkEntrypoints = readdirSync(checkBinDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(checkBinDir, f))
const checkOutdir = join(pkgRoot, 'dist', 'checks', 'bin')
await build(checkEntrypoints, checkOutdir)
for (const f of readdirSync(checkBinDir).filter((f) => f.endsWith('.ts'))) {
  normalizeExecutable(join(checkOutdir, f.replace(/\.ts$/, '.js')))
}

// The loop's existing-work dispatch verification lives in the core package,
// whose published files carry no scripts: bundle it beside the checks so the
// readiness gate resolves it through the installed CLI, never a source path.
const verifyDispatchSource = join(processChecksDir, 'standalone', 'verify-dispatch.ts')
if (!existsSync(verifyDispatchSource)) {
  console.error(`cannot bundle the existing-work dispatch verification: ${verifyDispatchSource} is missing`)
  process.exit(1)
}
// verify-dispatch counts findings by running verify-docs and verify-coherence,
// so their built copies ship beside it.
const verifyToolSources = ['verify-docs', 'verify-coherence'].map((n) =>
  join(processChecksDir, 'standalone', `${n}.ts`)
)
await build([verifyDispatchSource, ...verifyToolSources], checkOutdir)
if (!existsSync(join(checkOutdir, 'verify-dispatch.js'))) {
  console.error('the build emitted no dist/checks/bin/verify-dispatch.js')
  process.exit(1)
}
for (const n of ['verify-dispatch', 'verify-docs', 'verify-coherence']) {
  if (!existsSync(join(checkOutdir, `${n}.js`))) {
    console.error(`the build emitted no dist/checks/bin/${n}.js`)
    process.exit(1)
  }
  normalizeExecutable(join(checkOutdir, `${n}.js`))
}

// task-run-v1 20, O5/O6 — the pre-push hook's changed-files lister and test
// selector, two more `bin` entries (`package.json`'s `vinaya-changed-files`,
// `vinaya-select-tests`) alongside the main `vinaya` entrypoint, bundled
// exactly like a check bin so an adopter's published install can
// `npx --yes -p @attalabs/vinaya@<version> <bin>` either one without going
// through the CLI's own argv router at all.
// The hook's helpers, the hook's progress helper and the driver's progress observer: the program table's entries
// built under `dist/lib`, each from its source file; a published install reaches them here.
const libPrograms = [...PROGRAMS.values()].filter((program) => program.built.startsWith('dist/lib/'))
const libBinNames = libPrograms.map((program) => program.built.slice('dist/lib/'.length))
const libOutdir = join(pkgRoot, 'dist', 'lib')
await build(
  libPrograms.map((program) => join(pkgRoot, '..', '..', program.source)),
  libOutdir
)
for (const f of libBinNames) normalizeExecutable(join(libOutdir, f))

// The tool bridge is a program of its own, not a CLI command: an agent's sandbox
// runs this one file (`node dist/kernel/tools/host/dev-tools-bridge.js --socket <path>`)
// to reach the driver's dev-tools host, so a published install ships it beside the CLI.
const bridgeSource = join(pkgRoot, '..', '..', 'harness', 'kernel', 'tools', 'host', 'dev-tools-bridge.ts')
const bridgeOutdir = join(pkgRoot, 'dist', 'kernel', 'tools', 'host')
await build([bridgeSource], bridgeOutdir)
normalizeExecutable(join(bridgeOutdir, 'dev-tools-bridge.js'))

// Every program the process's program table names that the blocks above did not already emit (the audit and the
// plumbing programs the command line no longer routes), each into its own built file, one build per program so its
// file name — the name the program checks it was started as — is its own.
const repoRoot = join(pkgRoot, '..', '..')
for (const program of PROGRAMS.values()) {
  const outFile = join(pkgRoot, program.built)
  if (!program.built.startsWith('dist/programs/')) continue
  await build([join(repoRoot, program.source)], dirname(outFile))
  normalizeExecutable(outFile)
}
const unbuilt = [...PROGRAMS.values()].filter((program) => !existsSync(join(pkgRoot, program.built)))
if (unbuilt.length > 0) {
  console.error(`the build emitted no ${unbuilt.map((program) => program.built).join(', ')}`)
  process.exit(1)
}

console.log(
  `built dist/index.js + ${checkEntrypoints.length} check bin(s) + verify-dispatch in dist/checks/bin/ + ${libBinNames.length} lib bin(s) in dist/lib/ + ${PROGRAMS.size} program(s) (external: ${external.join(', ') || 'none'})`
)
