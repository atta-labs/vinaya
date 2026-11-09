import { existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Shared between `scripts/bundle-studio.ts` (pack time) and `commands/studio.ts` (run time), so the two cannot
 * disagree about where Studio lives or what the packer did to it.
 */

/** The Studio app's package name — how a checkout's Studio is found. */
export const STUDIO_PACKAGE_NAME = '@vinaya/studio'

/** The Studio app's folder, relative to the repository root. */
export const STUDIO_APP_RELPATH = 'apps/vinaya-studio'

/** The folder inside the CLI package that holds the assembled standalone server. */
export const STUDIO_BUNDLE_DIRNAME = 'studio-standalone'

/**
 * npm and bun's packer strip every folder literally named `node_modules` from a tarball, unconditionally, and the
 * shipped server then fails at its first `require('next')`. The pack step ships each one under this name, and the
 * command renames them back on first run.
 */
export const STUDIO_NODE_MODULES_PACKED_DIRNAME = '_node_modules'

const NODE_MODULES_DIRNAME = 'node_modules'

/** Folders from the bundle root down to the standalone server's own folder. */
export function studioServerSegments(): string[] {
  return STUDIO_APP_RELPATH.split('/')
}

/** The standalone server's folder inside a bundle root; its `server.js` starts Studio. */
export function studioServerDir(bundleRoot: string): string {
  return join(bundleRoot, ...studioServerSegments())
}

/**
 * Renames every entry named `from` under `dir` to `to`, deepest first, so a rename never moves a folder that is
 * still to be walked. Symbolic links are renamed but never followed.
 */
function renameAll(dir: string, from: string, to: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) renameAll(path, from, to)
    if (entry.name === from) renameSync(path, join(dir, to))
  }
}

/** Pack time: hides every `node_modules` folder under the bundle from the packer. */
export function packStudioNodeModules(bundleRoot: string): void {
  renameAll(bundleRoot, NODE_MODULES_DIRNAME, STUDIO_NODE_MODULES_PACKED_DIRNAME)
}

/**
 * Run time: restores the folders the pack step renamed. It acts only while the bundle root's own `node_modules` is
 * missing and its packed copy is present, and renames the root's last, so an interrupted repair is finished by the
 * next run. Returns whether it renamed anything.
 */
export function repairStudioNodeModules(bundleRoot: string): boolean {
  const real = join(bundleRoot, NODE_MODULES_DIRNAME)
  const packed = join(bundleRoot, STUDIO_NODE_MODULES_PACKED_DIRNAME)
  if (existsSync(real) || !existsSync(packed)) return false
  for (const entry of readdirSync(bundleRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      renameAll(join(bundleRoot, entry.name), STUDIO_NODE_MODULES_PACKED_DIRNAME, NODE_MODULES_DIRNAME)
    }
  }
  renameSync(packed, real)
  return true
}
