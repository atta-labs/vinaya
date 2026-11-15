#!/usr/bin/env bun
/**
 * Builds this repository's Studio app (`apps/vinaya-studio`) from its source and assembles an explicit deployment
 * bundle into `apps/cli/studio-standalone/` — a build-time artifact, gitignored, that `npm pack` and `npm publish`
 * (both run this via `prepack`) ship as a normal top-level package folder, the same convention `bundle-doctrine.ts`
 * uses. Nothing is downloaded: the build runs from the source in this checkout.
 *
 * Studio runs behind its own Node server (`src/server/host.ts`, through the public Next custom-server API), so the
 * build is a plain `next build` and Next's generated standalone `server.js` is not used: Next's own documentation says
 * standalone output does not trace custom server files and cannot be combined with one. The bundle is assembled from:
 *   - the production build (`.next`, minus its cache and build diagnostics);
 *   - the host, bundled for Node by `bun build` with `next` and `ws` left external;
 *   - every runtime file Next's documented output traces list (`.next/**` `*.nft.json`) plus every file `@vercel/nft`
 *     traces from the host itself, copied to the same path relative to the repository root they have in the checkout;
 *   - the app's `package.json` and a minimal `next.config.mjs` carrying only the runtime-relevant options.
 *
 * The bundle keeps the checkout's nesting: the app lives at `apps/vinaya-studio/` below the bundle root, so the hop
 * count between the app and the root's `node_modules` is the same as in the checkout.
 *
 * The packer strips every folder literally named `node_modules`, so each one is renamed to the shared packed name as
 * the last step; `vinaya studio` renames them back on first run.
 *
 * The build runs without the three variables that identify an agent's shell. Next.js prints an advisory nudge when it
 * sees them and exits 1 with the same output, and a non-zero exit is a failed build whatever files it left behind.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { nodeFileTrace } from '@vercel/nft'
import {
  packStudioNodeModules,
  STUDIO_APP_RELPATH,
  STUDIO_BUNDLE_DIRNAME,
  STUDIO_ENTRY_FILENAME,
  studioServerDir
} from '../src/lib/studio-bundle.js'

const AGENT_DETECTION_VARIABLES = ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] as const

/** Never needed to serve a production build, and large: Next's compiler binaries, image codecs, the type checker. */
const TRACE_IGNORE = [
  '**/node_modules/@next/swc-*/**',
  '**/node_modules/@img/**',
  '**/node_modules/sharp/**',
  '**/node_modules/typescript/**'
]

/** The same exclusions applied to the files Next's own traces list. */
const NEVER_SHIPPED = /(^|\/)node_modules\/(@next\/swc-[^/]+|@img|sharp|typescript)\//

/** Under `.next`, what the running server never reads. */
const BUILD_ONLY = new Set(['cache', 'trace', 'trace-build', 'diagnostics', 'types', 'dev'])

const pkgRoot = join(import.meta.dir, '..')
const monorepoRoot = join(pkgRoot, '..', '..')
const appRoot = join(monorepoRoot, ...STUDIO_APP_RELPATH.split('/'))
const targetRoot = join(pkgRoot, STUDIO_BUNDLE_DIRNAME)

function fail(message: string): never {
  console.error(`bundle-studio: ${message}`)
  process.exit(1)
}

/** The packages the host imports directly, as the app's `package.json` declares them besides `next`. */
const HOST_RUNTIME_PACKAGES = ['ws'] as const

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]
  )
}

function listNftFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (BUILD_ONLY.has(entry.name) && dir === join(appRoot, '.next')) continue
      found.push(...listNftFiles(path))
    } else if (entry.name.endsWith('.nft.json')) found.push(path)
  }
  return found
}

if (!existsSync(join(appRoot, 'package.json'))) {
  fail(`the Studio app ${appRoot} does not exist — run from within the vinaya repository.`)
}

// Before the build, not only before the copy: a stale copy of the target must never be swept into the new bundle.
rmSync(targetRoot, { recursive: true, force: true })

const env: NodeJS.ProcessEnv = { ...process.env }
for (const name of AGENT_DETECTION_VARIABLES) delete env[name]

console.log(`bundle-studio: building ${STUDIO_APP_RELPATH} (next build)...`)
// The webpack bundler, not the app's default one: Turbopack evaluates PostCSS in a child process that binds a local
// port, which fails wherever local listening is refused (a sandboxed pack or CI step) and the output is the same
// layout either way.
const build = spawnSync('bun', ['run', 'next', 'build', '--webpack'], { cwd: appRoot, stdio: 'inherit', env })
if (build.status !== 0) {
  fail(`the Studio build failed (${build.error ? build.error.message : `exit ${build.status}`}).`)
}
const nextDir = join(appRoot, '.next')
if (!existsSync(join(nextDir, 'BUILD_ID'))) fail(`the build left no ${join(nextDir, 'BUILD_ID')}.`)

// The host, bundled for Node. `next` and `ws` stay external so the traced packages are the ones that run.
const hostBundle = join(nextDir, 'studio-host', STUDIO_ENTRY_FILENAME)
const hostBuild = spawnSync(
  'bun',
  [
    'build',
    join(appRoot, 'src', 'server', 'entry.ts'),
    '--target=node',
    '--format=esm',
    '--external=next',
    '--external=ws',
    `--outfile=${hostBundle}`
  ],
  { cwd: appRoot, stdio: 'inherit', env }
)
if (hostBuild.status !== 0 || !existsSync(hostBundle)) {
  fail(`bundling the Studio host failed (${hostBuild.error ? hostBuild.error.message : `exit ${hostBuild.status}`}).`)
}

// Every runtime file: Next's documented traces first, then the host's own graph.
const runtimeFiles = new Set<string>()
for (const nftPath of listNftFiles(nextDir)) {
  const trace = JSON.parse(readFileSync(nftPath, 'utf-8')) as { files?: string[] }
  for (const file of trace.files ?? []) runtimeFiles.add(resolve(dirname(nftPath), file))
}
const requireFromApp = createRequire(join(appRoot, 'package.json'))
// The host loads `next` through a constant specifier, so the trace is seeded with Next's entry by name.
const hostTrace = await nodeFileTrace([hostBundle, requireFromApp.resolve('next')], {
  base: monorepoRoot,
  processCwd: monorepoRoot,
  ignore: TRACE_IGNORE
})
for (const file of hostTrace.fileList) runtimeFiles.add(resolve(monorepoRoot, file))
// The host's own declared dependencies are packed whole and by name, never left to static analysis: it resolves `ws`
// through a package `exports` map, and a missing one would only show when Studio starts.
for (const name of HOST_RUNTIME_PACKAGES) {
  for (const file of listFiles(dirname(requireFromApp.resolve(`${name}/package.json`)))) runtimeFiles.add(file)
}

mkdirSync(targetRoot, { recursive: true })
const targetServerDir = studioServerDir(targetRoot)
let copied = 0
for (const file of runtimeFiles) {
  const rel = relative(monorepoRoot, file)
  if (rel.startsWith(`..${sep}`) || rel === '..') fail(`a traced runtime file lies outside the repository: ${file}`)
  if (rel.split(sep).some((part) => part === '.git')) continue
  if (NEVER_SHIPPED.test(rel.split(sep).join('/'))) continue
  if (!existsSync(file) || statSync(file).isDirectory()) continue
  const dest = join(targetRoot, rel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(file, dest, { dereference: true })
  copied++
}

// The production build itself: the traces list what its pages load, not the manifests Next reads at start.
mkdirSync(targetServerDir, { recursive: true })
cpSync(nextDir, join(targetServerDir, '.next'), {
  recursive: true,
  dereference: true,
  filter: (source) => !(dirname(source) === nextDir && BUILD_ONLY.has(source.slice(nextDir.length + 1)))
})
cpSync(hostBundle, join(targetServerDir, STUDIO_ENTRY_FILENAME))
rmSync(join(targetServerDir, '.next', 'studio-host'), { recursive: true, force: true })

const publicDir = join(appRoot, 'public')
if (existsSync(publicDir)) cpSync(publicDir, join(targetServerDir, 'public'), { recursive: true })

// The runtime reads only these options; the app's own config is TypeScript, which the shipped server must not need to
// compile. `distDir` is the build output's folder.
cpSync(join(appRoot, 'package.json'), join(targetServerDir, 'package.json'))
writeFileSync(join(targetServerDir, 'next.config.mjs'), `export default { distDir: '.next' }\n`)

if (!existsSync(join(targetServerDir, STUDIO_ENTRY_FILENAME))) fail(`the bundle has no ${STUDIO_ENTRY_FILENAME}.`)
for (const required of ['next', 'ws', 'react', 'react-dom']) {
  if (!existsSync(join(targetRoot, 'node_modules', required, 'package.json'))) {
    fail(`the bundle carries no runtime dependency "${required}" under ${join(targetRoot, 'node_modules')}.`)
  }
}

packStudioNodeModules(targetRoot)

console.log(`bundle-studio: assembled Studio into ${targetRoot} (${copied} traced files)`)
