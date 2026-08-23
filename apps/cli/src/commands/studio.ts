import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { packageRoot } from '../lib/package-root.js'
import { STUDIO_NODE_MODULES_PACKED_DIRNAME } from '../lib/studio-bundle.js'

const execFileAsync = promisify(execFile)

/** `resolveRepo()`'s default git exec has no `cwd` option — it always reads
 *  the CALLING process's own `process.cwd()`, which is exactly right here
 *  (called before the child's chdir, see `spawnStandalone`'s doc comment)
 *  EXCEPT this CLI's own process.cwd() isn't guaranteed to equal the `cwd`
 *  argument threaded through `resolveStudioTarget`/`runStudio` (tests pass
 *  an arbitrary fixture dir). Passing `cwd` explicitly here removes that
 *  assumption. */
function execFileForRepo(cwd: string): Promise<{ stdout: string }> {
  return execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5000 })
}

export type StudioTarget =
  | { kind: 'workspace'; webDir: string }
  | { kind: 'package'; packageDir: string }
  | { kind: 'missing' }

// Exported so `verify-published-lifecycle.ts`'s `studio` exercise derives the
// ports it probes rather than hand-maintaining a second copy that could drift.
export const PRIMARY_PORT = 3008
export const FALLBACK_PORT = 3108

/**
 * `--port <n>`, or `null` when unset. Explicit means explicit: the caller is
 * pinning a port, so the `PRIMARY → FALLBACK` dance below is skipped and a
 * taken port is a loud refusal rather than a silent move.
 *
 * That asymmetry is the point. The default pair exists so a casual `vinaya
 * studio` still comes up when something else holds `3008`; but a caller who
 * NAMED a port did so to know which server they are talking to, and silently
 * answering on a different one reintroduces exactly the ambiguity they were
 * removing. Measured live: with two Studio servers up, one on `*:3008` and one
 * on `127.0.0.1:3008`, a `200` from `/studio` proved nothing about which
 * process served it without inspecting the established connection.
 *
 * This repo's own `dev:vinaya-studio` script pins a port for that reason —
 * attalabs' Studio dev server owns `3008`, and the two must not collide.
 */
export function parsePortFlag(args: string[]): number | null {
  // Both spellings. `--port=3208` is accepted elsewhere in this CLI
  // (`forge-write.ts` parses `--flag=value`), and a parser that silently
  // returned `null` for it would bind the DEFAULT port — which is precisely
  // the collision this flag exists to prevent, arrived at silently. A caller
  // who wrote `--port=3208` gets that port or an error, never `3008`.
  const found: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    if (a === '--port') {
      const raw = args[k + 1]
      if (raw === undefined || raw.startsWith('-')) throw new PortFlagError('`--port` requires a port number.')
      found.push(raw)
      k++
    } else if (a.startsWith('--port=')) {
      found.push(a.slice('--port='.length))
    }
  }
  if (found.length === 0) return null
  // Two different values is an unresolvable instruction, not a precedence
  // question. Picking one silently discards the other, and the whole point of
  // an explicit port is that the caller knows which one they got.
  if (found.length > 1 && new Set(found).size > 1) {
    throw new PortFlagError(`\`--port\` given more than once with different values (${found.join(', ')}).`)
  }
  const raw = found[0] as string
  if (raw === '') throw new PortFlagError('`--port` requires a port number.')
  if (!/^[0-9]+$/.test(raw)) throw new PortFlagError(`\`--port ${raw}\` is not a port number.`)
  // Reject leading zeros rather than normalising them: `--port 03208` reads as
  // a typo, and quietly binding 3208 would hide it.
  if (raw.length > 1 && raw.startsWith('0'))
    throw new PortFlagError(`\`--port ${raw}\` has a leading zero — write it as ${Number(raw)}.`)
  const port = Number(raw)
  if (port < 1 || port > 65535) throw new PortFlagError(`\`--port ${raw}\` is outside the valid range 1-65535.`)
  return port
}

/** Thrown for a malformed `--port`; the caller renders it and exits non-zero rather than binding something unintended. */
export class PortFlagError extends Error {}

/**
 * THE resolution seam. One function, three outcomes, in this order:
 *   1. workspace — walk up from `cwd` for `apps/vinaya-studio/web/package.json`
 *      whose `name` is `@atta/vinaya-studio-web`. Studio's SOURCE does not
 *      live in this repository — the CLI was extracted here while Studio's
 *      app stayed behind in the attalabs monorepo — so this branch answers
 *      only when the command runs inside a checkout that still carries that
 *      tree.
 *   2. package  — the published shape: this installed package's own
 *      `studio-standalone/apps/vinaya-studio/web/server.js`, fetched from
 *      attalabs' published release artifact at `prepack` time
 *      (`scripts/bundle-studio.ts`) and shipped in the `files` allowlist.
 *      Located relative to THIS module's own install root —
 *      `packageRoot()`'s caller-supplied-URL contract, same pattern
 *      `registry.ts`/`doctor.ts` already use, and why `moduleUrl` is a
 *      parameter here rather than a module-level constant: it lets a test
 *      inject a fake install root without touching the real one.
 *   3. missing  — neither found. Only reachable if a publish shipped without
 *      the Studio bundle (e.g. the attalabs artifact fetch failed and
 *      `prepack` was forced through anyway) — `runStudio` turns it into an
 *      explicit refusal rather than a silent no-op.
 */
export function resolveStudioTarget(cwd: string, moduleUrl: string = import.meta.url): StudioTarget {
  let dir = cwd
  for (;;) {
    const webDir = join(dir, 'apps', 'vinaya-studio', 'web')
    const pkgPath = join(webDir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        if (pkg.name === '@atta/vinaya-studio-web') {
          return { kind: 'workspace', webDir }
        }
      } catch {
        // malformed package.json — keep walking up
      }
    }
    // The walk never crosses the enclosing repository's own root (`.git` is a
    // directory in a primary checkout, a gitlink file in a linked worktree —
    // existsSync covers both). Without this bound the walk continues to the
    // filesystem root, and the branch below EXECUTES the resolved directory's
    // `dev` script — so a planted `apps/vinaya-studio/web/package.json` in a
    // world-writable ancestor (`/tmp`) would run arbitrary code the moment
    // `vinaya studio` runs from anywhere beneath it (security review, PR #94
    // finding 3). Checked AFTER the webDir probe so a monorepo root that
    // carries both `.git` and `apps/vinaya-studio/web` still resolves.
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const standaloneWebDir = join(packageRoot(moduleUrl), 'studio-standalone', 'apps', 'vinaya-studio', 'web')
  if (existsSync(join(standaloneWebDir, 'server.js'))) {
    return { kind: 'package', packageDir: standaloneWebDir }
  }

  return { kind: 'missing' }
}

function spawnDev(webDir: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    // `bun run dev` (not a direct `bun scripts/dev.ts` invocation) — bun's
    // `run` puts the workspace's node_modules/.bin on PATH for the child,
    // which `next` needs; a bare script invocation does not.
    //
    // This branch gets NO loopback forcing, unlike `spawnStandalone` below —
    // deliberately, not by omission (security review, PR #94 finding 1). The
    // resolved workspace's own `dev` script (attalabs `apps/vinaya-studio/web/
    // scripts/dev.ts`) execs `next dev` itself, ignores argv, and reads no
    // HOSTNAME — nothing this spawn passes would change its bind address, so
    // forcing env here would only pretend to harden. The exposure is exactly
    // that of running `bun run dev` in that checkout directly; fixing the
    // bind belongs where the dev script lives, and to the Studio-packaging
    // work (#43) whose published shape DOES get the loopback default below.
    const child = spawn('bun', ['run', 'dev', ...args], { cwd: webDir, stdio: 'inherit' })
    child.on('exit', (code) => resolve(code ?? 0))
  })
}

/** Free if the bind succeeds, taken if it errors (almost always EADDRINUSE).
 *  The probe binds loopback — the same address the server it gates defaults
 *  to — not `0.0.0.0` (security review, PR #94 finding 5): detection is
 *  equivalent (an all-interfaces listener on the port still makes the
 *  loopback bind fail EADDRINUSE), and it keeps this file free of
 *  all-interfaces binds it doesn't mean. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => tester.close(() => resolve(true)))
    tester.listen(port, '127.0.0.1')
  })
}

/** Repairs the pack-time rename bundle-studio.ts applies to the bundle's
 *  `node_modules` (see its own doc comment: npm/bun's packer unconditionally
 *  strips any directory literally named `node_modules`, so it ships as
 *  `_node_modules` instead). A lazy, idempotent runtime fix rather than a
 *  `postinstall` script — postinstall is routinely disabled
 *  (`--ignore-scripts`), which would leave `require('next')` broken with no
 *  recovery path; this repairs on every invocation until it's already been
 *  fixed, which costs one `existsSync` call once fixed. */
function ensureStudioNodeModules(bundleRoot: string): void {
  const real = join(bundleRoot, 'node_modules')
  const packed = join(bundleRoot, STUDIO_NODE_MODULES_PACKED_DIRNAME)
  if (!existsSync(real) && existsSync(packed)) {
    renameSync(packed, real)
  }
}

/** Spawns the bundled standalone Studio server. `cwd` is the CALLER's own
 *  cwd (the guest repo), not `packageDir` — `server.js`'s own require/asset
 *  resolution is relative to its own file location (verified live: it
 *  serves correctly from an unrelated cwd).
 *
 *  That cwd-independence does NOT extend to the APP's own runtime repo-root
 *  reads, though — Next's generated `server.js` does `process.chdir(__dirname)`
 *  as its own first line (confirmed live, every standalone build), so by the
 *  time app code calls `resolveRepo()` the process cwd is back on the
 *  installed package, not the guest repo, and a plain `git remote get-url
 *  origin` there fails with "not a git repository". `AEG_REPO` is
 *  `resolveRepo()`'s own documented override (checked before it falls back to
 *  the git lookup) — resolving it HERE, before the chdir happens, and forcing
 *  it into the child's env is what makes the chdir harmless. This is the one
 *  thing standing between this task and the exact manual "AEG_REPO env var
 *  trick" workaround the Issue names as what package mode should retire; an
 *  explicit `AEG_REPO` the caller already set is preserved (`resolveRepo`
 *  checks it first internally, so this never overrides a real override).
 *
 *  `HOSTNAME` is forced to loopback-only (`127.0.0.1`) unless the caller's
 *  own environment already sets it. The bundled `server.js` reads
 *  `process.env.HOSTNAME || '0.0.0.0'` — unset, it binds every interface,
 *  which for `next dev` inside this monorepo is a pre-existing, narrow
 *  exposure (only reachable by someone who already has this checkout and
 *  runs it themselves). Shipping the *package* branch on the public npm
 *  registry is a different exposure: it turns the same unauthenticated
 *  bind into a default for any `npx @attalabs/vinaya studio` invocation,
 *  in any adopter's repo, reachable by anything else on the same network
 *  for the life of the process, serving that repo's real forge-derived
 *  tranche/task data with no auth (security review, PR #855). Loopback-only
 *  is the safe default; an operator who genuinely wants LAN access can
 *  still set `HOSTNAME` themselves.
 *
 *  `VINAYA_REPO_ROOT` closes the gap the paragraph above flags but doesn't
 *  fix: `AEG_REPO` only survives the chdir for git-remote/GitHub-API reads
 *  (`resolveRepo()`). The app's FILE-based repo-root walks — `.vinaya/
 *  projects.md` (`web/src/lib/repo-state/read-root.ts`), `vinaya.config.json`
 *  (`web/src/lib/github-links.ts`), and `aeg-root/` (`web/src/lib/docs/
 *  load-aeg-docs.ts`) — all default to a bare `process.cwd()` walk with no
 *  override, so they silently resolved the installed package's own tree
 *  post-chdir and returned empty/missing state (found live: Projects showed
 *  "No projects registered" despite a real `.vinaya/projects.md` existing).
 *  Same fix shape as `AEG_REPO`: capture `cwd` here, before the chdir,
 *  force it into the child's env. */
async function spawnStandalone(
  cwd: string,
  serverPath: string,
  bundleRoot: string,
  explicitPort: number | null
): Promise<number> {
  ensureStudioNodeModules(bundleRoot)

  const repo = await resolveRepo(() => execFileForRepo(cwd))

  let port: number
  if (explicitPort !== null) {
    // No fallback: see `parsePortFlag`. A pinned port that quietly became a
    // different port is worse than a refusal, because the caller would then
    // attribute another server's responses to this one.
    if (!(await isPortFree(explicitPort))) {
      console.error(
        `[studio] port ${explicitPort} is taken, and \`--port\` was given explicitly — refusing to bind elsewhere.`
      )
      return 1
    }
    port = explicitPort
  } else {
    const primaryFree = await isPortFree(PRIMARY_PORT)
    port = primaryFree ? PRIMARY_PORT : FALLBACK_PORT
    if (!primaryFree) {
      console.info(`[studio] port ${PRIMARY_PORT} is taken — falling back to ${FALLBACK_PORT}`)
    }
  }

  const env: NodeJS.ProcessEnv = { HOSTNAME: '127.0.0.1', ...process.env, PORT: String(port), VINAYA_REPO_ROOT: cwd }
  if (repo) env.AEG_REPO = `${repo.owner}/${repo.repo}`

  return new Promise((resolve) => {
    const child = spawn('node', [serverPath], { cwd, stdio: 'inherit', env })
    child.on('exit', (code) => resolve(code ?? 0))
  })
}

/** Runs the `studio` command. Spawns the resolved target's serve entry with
 *  stdio inherited and resolves with the child's exit code. On `missing`,
 *  prints the one-line install hint and resolves 1. `moduleUrl` forwards to
 *  `resolveStudioTarget` — see its own doc comment for why it's a param. */
export async function runStudio(cwd: string, args: string[], moduleUrl: string = import.meta.url): Promise<number> {
  let explicitPort: number | null
  try {
    explicitPort = parsePortFlag(args)
  } catch (err) {
    if (err instanceof PortFlagError) {
      console.error(`[studio] ${err.message}`)
      return 2
    }
    throw err
  }

  const target = resolveStudioTarget(cwd, moduleUrl)

  switch (target.kind) {
    case 'workspace':
      // `--port` cannot take effect here, and saying so is the honest move.
      // This branch execs the resolved workspace's OWN `dev` script (attalabs'
      // `apps/vinaya-studio/web/scripts/dev.ts`), which execs `next dev` with
      // its own `--port` and ignores argv — the same reason this branch gets no
      // loopback forcing above. Accepting the flag silently would report a port
      // the server never binds.
      if (explicitPort !== null) {
        console.error(
          `[studio] \`--port ${explicitPort}\` cannot apply here: this is a workspace checkout, and Studio's own dev script chooses the port. Set it there, or run against a published install.`
        )
        return 2
      }
      return spawnDev(target.webDir, args)
    case 'package': {
      // packageDir is <bundleRoot>/apps/vinaya-studio/web — the same
      // nesting attalabs' `next build` tracing produced and
      // bundle-studio.ts preserved when it fetched and assembled the
      // artifact.
      const bundleRoot = join(target.packageDir, '..', '..', '..')
      return spawnStandalone(cwd, join(target.packageDir, 'server.js'), bundleRoot, explicitPort)
    }
    case 'missing':
      console.error(
        "Vinaya Studio isn't available in this install — no published @attalabs/vinaya build bundles the Studio app yet. Inside a checkout that contains Studio's source (apps/vinaya-studio/web), `vinaya studio` runs it directly."
      )
      return 1
  }
}
