#!/usr/bin/env bun
/**
 * Fetches the standalone Studio build (`next build`, `output: 'standalone'`)
 * that `atta-labs/attalabs`'s `.github/workflows/vinaya-studio-artifact.yml`
 * publishes as a GitHub Release asset on the rolling `studio-standalone-latest`
 * tag, unpacks it, and assembles `apps/cli/studio-standalone/` — a build-time
 * artifact (gitignored, same convention `bundle-doctrine.ts` already uses for
 * `aeg-root/`) that `npm pack`/`npm publish` ships as a normal top-level
 * package directory.
 *
 * Studio's SOURCE (`apps/vinaya-studio/web`) lives in the attalabs monorepo,
 * not this repository — the CLI was extracted here while attalabs kept the
 * app. Rather than requiring that source tree locally (the old shape, when
 * the app was still `apps/vinaya/web` and had not yet moved), this script
 * fetches attalabs' own CI-built output over HTTPS: `atta-labs/attalabs` is
 * PUBLIC, so the release asset needs no token — an artifact consumer would
 * never need a credential this repo's own publish flow doesn't already have.
 *
 * Wired into `prepack` (`package.json`): `npm publish`/`bun pm pack` runs
 * this script every time, so the tarball always carries whatever attalabs
 * `main` currently builds at the moment of publish — not a vendored snapshot
 * that goes stale between attalabs Studio changes and the next vinaya
 * release. Publish is a manual, human-run step today (no CI runs `prepack`
 * yet), so the one-time network fetch this adds costs a publish, not a CI
 * run.
 *
 * The fetched artifact is the raw `next build` output: `standalone/`,
 * `static/`, and `public/` (only when attalabs' build actually produced one
 * — `apps/vinaya-studio/web` does not have a `public/` dir today) as three
 * top-level tarball entries. ASSEMBLY is this script's job, same as when it
 * ran `next build` itself: copy `static/` and `public/` into the standalone
 * tree at the nesting Next's tracer produced, then rename `node_modules` so
 * npm/bun's packer doesn't strip it.
 *
 * Next's tracing preserves the workspace-relative path from wherever
 * `next build` ran in attalabs, so the standalone output nests the real
 * entrypoint at `apps/vinaya-studio/web/server.js` *inside* the bundle — this
 * script does not flatten that (three path segments, same depth
 * `apps/vinaya/web` had before the move — `studio.ts`'s `'..','..','..'` hop
 * count back to the bundle root stays correct because the depth didn't
 * change, only the middle segment's name did). `server.js`'s own
 * require/static resolution is relative to its own file location, not
 * `process.cwd()` (verified live: it serves pages and `/_next/static/*`
 * assets correctly when launched from an unrelated cwd) — BUT that same
 * generated `server.js` also runs `process.chdir(__dirname)` as its own
 * first line (every standalone build does this, not something this script
 * controls), so by the time app code reads `process.cwd()` the process has
 * moved off the caller's cwd and back onto this installed package.
 * `studio.ts`'s package branch works around that — see its own
 * `spawnStandalone` doc comment.
 *
 * The bundle's `node_modules` (holding `next`, `react`, `sharp`, … —
 * `server.js`'s own real runtime requires) gets renamed to `_node_modules`
 * as the final step. npm/bun's packer strips ANY directory literally named
 * `node_modules` from a published tarball, unconditionally — confirmed live:
 * `bun pm pack` silently drops this one, and the installed package then
 * fails at `require('next')`. `studio.ts`'s package branch renames it back
 * on first run (see its own comment for why that's a lazy runtime repair
 * rather than a `postinstall` script).
 *
 * `apps/vinaya-studio/web/next.config.ts` sets no `outputFileTracingIncludes`
 * (Studio never deploys to Vercel, so there is no serverless bundle to keep
 * a computed-path read from silently dropping) — unlike the old
 * `apps/vinaya/web`, whose standalone output baked attalabs' own `aeg-root/`,
 * `.vinaya/projects.md`, and `vinaya.config.json` into the bundle root via
 * that setting. The cleanup step below that deletes those three paths is
 * therefore a no-op against today's artifact — every `existsSync` check it
 * runs is false. Kept anyway, deliberately, as defense-in-depth: it costs
 * three `existsSync` calls per bundle, and if `outputFileTracingIncludes`
 * (or an equivalent baking mechanism) is ever reintroduced upstream, this is
 * still the one place that strips attalabs' own facts from a bundle a guest
 * would otherwise silently see instead of their own — the exact regression
 * (`/studio/projects` returning attalabs' own `herald`/`vada`/`vinaya`
 * instead of the guest's) this deletion existed to prevent when the app was
 * `apps/vinaya/web`.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STUDIO_ARTIFACT_ASSET_NAME,
  STUDIO_ARTIFACT_OWNER,
  STUDIO_ARTIFACT_RELEASE_TAG,
  STUDIO_ARTIFACT_REPO,
  STUDIO_NODE_MODULES_PACKED_DIRNAME
} from '../src/lib/studio-bundle.js'

const pkgRoot = join(import.meta.dir, '..')
const targetRoot = join(pkgRoot, 'studio-standalone')

type ReleaseAsset = { name: string; browser_download_url: string; size: number }
type Release = { tag_name: string; target_commitish: string; assets: ReleaseAsset[] }

async function fetchLatestRelease(): Promise<Release> {
  const url = `https://api.github.com/repos/${STUDIO_ARTIFACT_OWNER}/${STUDIO_ARTIFACT_REPO}/releases/tags/${STUDIO_ARTIFACT_RELEASE_TAG}`
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) {
    throw new Error(
      `bundle-studio: fetching release metadata failed (${res.status} ${res.statusText}) from ${url} — ` +
        `is the vinaya-studio-artifact.yml workflow published on ${STUDIO_ARTIFACT_OWNER}/${STUDIO_ARTIFACT_REPO}'s main branch yet?`
    )
  }
  return (await res.json()) as Release
}

// Shells out to `curl` rather than `fetch()` + `Bun.write(file, response)`:
// confirmed live that the fetch+stream path pathologically hangs (minutes,
// pegged at ~100% CPU, no bytes reaching disk) on this asset's actual
// redirect chain (github.com/.../download/... -> a signed
// release-assets.githubusercontent.com URL), while a plain `curl -sL`
// against the identical URL completes in under a second. `tar` a few lines
// below is already a system-tool shell-out for the same reason (portable,
// proven, not fighting a runtime's own HTTP client).
function downloadAsset(url: string, destFile: string): void {
  const result = spawnSync('curl', ['-sL', '--fail', '-o', destFile, url], { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`bundle-studio: downloading asset failed (curl exit ${result.status}) from ${url}`)
  }
}

console.log(
  `bundle-studio: fetching latest Studio artifact from ${STUDIO_ARTIFACT_OWNER}/${STUDIO_ARTIFACT_REPO}@${STUDIO_ARTIFACT_RELEASE_TAG}...`
)
const release = await fetchLatestRelease()
const asset = release.assets.find((a) => a.name === STUDIO_ARTIFACT_ASSET_NAME)
if (!asset) {
  console.error(
    `bundle-studio: release ${release.tag_name} has no asset named ${STUDIO_ARTIFACT_ASSET_NAME} — found: ${release.assets.map((a) => a.name).join(', ') || '(none)'}`
  )
  process.exit(1)
}

const workDir = mkdtempSync(join(tmpdir(), 'vinaya-studio-artifact-'))
const tarballPath = join(workDir, STUDIO_ARTIFACT_ASSET_NAME)
try {
  console.log(
    `bundle-studio: downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB) from commit ${release.target_commitish}...`
  )
  downloadAsset(asset.browser_download_url, tarballPath)

  // The tarball's entries are rooted at `.` (the producer workflow tars with
  // `-C /tmp/studio-artifact .`), so extracting straight into `workDir`
  // reproduces `standalone/` / `static/` / `public/` as siblings of the
  // tarball itself.
  const untar = spawnSync('tar', ['-xzf', tarballPath, '-C', workDir], { stdio: 'inherit' })
  if (untar.status !== 0) {
    console.error('bundle-studio: tar extraction failed.')
    process.exit(untar.status ?? 1)
  }

  const standaloneDir = join(workDir, 'standalone')
  const staticDir = join(workDir, 'static')
  const publicDir = join(workDir, 'public')
  const standaloneWebDir = join(standaloneDir, 'apps', 'vinaya-studio', 'web')

  if (!existsSync(join(standaloneWebDir, 'server.js'))) {
    console.error(
      `bundle-studio: expected ${join(standaloneWebDir, 'server.js')} in the fetched artifact — got an unexpected shape.`
    )
    process.exit(1)
  }

  // MUST clear the target first: a stale `studio-standalone/` from a prior
  // run has nothing to do with this fetch (there is no tracer re-running
  // here to sweep it back in, unlike the old local-build script), but a
  // clean copy destination avoids leaving orphaned files from a previous,
  // differently-shaped artifact.
  if (existsSync(targetRoot)) rmSync(targetRoot, { recursive: true, force: true })

  cpSync(standaloneDir, targetRoot, { recursive: true })
  cpSync(staticDir, join(targetRoot, 'apps', 'vinaya-studio', 'web', '.next', 'static'), { recursive: true })
  // Guarded, not unconditional: the fetched artifact only has a `public/`
  // entry when attalabs' own build produced one, and
  // `apps/vinaya-studio/web` doesn't have a `public/` dir today (unlike the
  // old `apps/vinaya/web`, which had 14 files under it) — an unconditional
  // copy here is an ENOENT waiting to happen the moment the source has none.
  if (existsSync(publicDir)) {
    cpSync(publicDir, join(targetRoot, 'apps', 'vinaya-studio', 'web', 'public'), { recursive: true })
  }

  const realNodeModules = join(targetRoot, 'node_modules')
  const packedNodeModules = join(targetRoot, STUDIO_NODE_MODULES_PACKED_DIRNAME)
  if (existsSync(realNodeModules)) {
    renameSync(realNodeModules, packedNodeModules)
  }

  // Defense-in-depth no-op against today's artifact — see this file's top
  // comment for why it's kept rather than removed.
  const monorepoOwnFacts = ['aeg-root', '.vinaya', 'vinaya.config.json']
  for (const name of monorepoOwnFacts) {
    const p = join(targetRoot, name)
    if (existsSync(p)) rmSync(p, { recursive: true, force: true })
  }

  console.log(`bundle-studio: fetched and assembled ${release.tag_name} into ${targetRoot}`)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
