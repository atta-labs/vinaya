#!/usr/bin/env bun
/**
 * Builds this repository's Studio app (`apps/vinaya-studio`, `output: 'standalone'`) from its source and assembles
 * the standalone server into `apps/cli/studio-standalone/` — a build-time artifact, gitignored, that `npm pack` and
 * `npm publish` (both run this via `prepack`) ship as a normal top-level package folder, the same convention
 * `bundle-doctrine.ts` uses. Nothing is downloaded: the build runs from the source in this checkout.
 *
 * The build places the server at `apps/vinaya-studio/server.js` inside the standalone folder, below its root by the
 * number of folders in the app's path; that nesting is kept, not flattened, and the hop count is derived from the
 * app's path. The app has no `public` folder, so static files and `public` are copied only where they exist.
 *
 * The packer strips every folder literally named `node_modules`, so each one is renamed to the shared packed name as
 * the last step; `vinaya studio` renames them back on first run.
 *
 * The build runs without the three variables that identify an agent's shell. Next.js prints an advisory nudge when it
 * sees them and exits 1 with the same output, and a non-zero exit is a failed build whatever files it left behind.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  packStudioNodeModules,
  STUDIO_APP_RELPATH,
  STUDIO_BUNDLE_DIRNAME,
  studioServerDir
} from '../src/lib/studio-bundle.js'

const AGENT_DETECTION_VARIABLES = ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] as const

const pkgRoot = join(import.meta.dir, '..')
const monorepoRoot = join(pkgRoot, '..', '..')
const appRoot = join(monorepoRoot, ...STUDIO_APP_RELPATH.split('/'))
const targetRoot = join(pkgRoot, STUDIO_BUNDLE_DIRNAME)

if (!existsSync(join(appRoot, 'package.json'))) {
  console.error(`bundle-studio: the Studio app ${appRoot} does not exist — run from within the vinaya repository.`)
  process.exit(1)
}

// Before the build, not only before the copy: the tracer would sweep a stale copy of the target back into the new
// standalone output.
rmSync(targetRoot, { recursive: true, force: true })

const env: NodeJS.ProcessEnv = { ...process.env }
for (const name of AGENT_DETECTION_VARIABLES) delete env[name]

console.log(`bundle-studio: building ${STUDIO_APP_RELPATH} (next build, output: standalone)...`)
const build = spawnSync('bun', ['run', 'build'], { cwd: appRoot, stdio: 'inherit', env })
if (build.status !== 0) {
  console.error(
    `bundle-studio: the Studio build failed (${build.error ? build.error.message : `exit ${build.status}`}).`
  )
  process.exit(build.status ?? 1)
}

const standaloneDir = join(appRoot, '.next', 'standalone')
const standaloneServerDir = studioServerDir(standaloneDir)
if (!existsSync(join(standaloneServerDir, 'server.js'))) {
  console.error(`bundle-studio: the build left no ${join(standaloneServerDir, 'server.js')}.`)
  process.exit(1)
}

cpSync(standaloneDir, targetRoot, { recursive: true })

const targetServerDir = studioServerDir(targetRoot)
const staticDir = join(appRoot, '.next', 'static')
if (existsSync(staticDir)) cpSync(staticDir, join(targetServerDir, '.next', 'static'), { recursive: true })
const publicDir = join(appRoot, 'public')
if (existsSync(publicDir)) cpSync(publicDir, join(targetServerDir, 'public'), { recursive: true })

packStudioNodeModules(targetRoot)

console.log(`bundle-studio: assembled the standalone Studio into ${targetRoot}`)
