#!/usr/bin/env bun
/**
 * atta-labs/process-version-bump — a custom vinaya check that refuses a branch
 * changing how the Vinaya process works without raising the `version` in its
 * process definition (`processes/vinaya/process.yaml`).
 *
 * Contract: emit one JSON line on stderr per finding via `emitCheckError`,
 * then exit 0 (pass) or 1 (findings or an undecidable state). The RUNNER
 * enforces the timeout. This file is standalone (no import from the vinaya
 * CLI's own source tree).
 *
 * Governed files, relative to the process folder:
 *   - `process.yaml` itself, for any change other than its `version` line
 *   - the flow file the head's `process.yaml` names under `flow`
 *   - `doctrine.md`, `grants.yaml` and `output.schema.json` in every role
 *     folder the head's `process.yaml` names under `roles`
 *   - `executing/actions.ts`, the action and decision bindings
 *
 * The flow and role folders are read from the head's process definition, so a
 * role added later is governed with no edit here. When a governed file changed
 * (against the merge base with the base ref, staged and unstaged edits
 * included), the head version must be a higher semantic version than the base
 * version. When none changed, the check passes and says it skipped.
 *
 * Anything that stops the check deciding — no base, a failed `git diff`, a
 * missing or unparseable process definition, a missing or non-semantic
 * version on either side — is an error, never a pass.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { parse } from 'yaml'

type CheckError = {
  schema: 1
  check: string
  severity: 'error' | 'warning'
  message: string
  agent_recovery_prompt: string
  file?: string
  line?: number
}

export type ProcessDefinition = { version: string; flow: string; roles: string[] }

export type SemVer = { major: number; minor: number; patch: number; prerelease: string[] }

const CHECK_NAME = 'atta-labs/process-version-bump'
export const PROCESS_FOLDER = 'processes/vinaya'
export const PROCESS_FILE = `${PROCESS_FOLDER}/process.yaml`
const ROLE_FILES = ['doctrine.md', 'grants.yaml', 'output.schema.json']
const BINDINGS_FILE = 'executing/actions.ts'

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

// A top-level `version:` line; nested keys are indented and never match.
const VERSION_LINE_RE = /^version\s*:/

class Undecidable extends Error {
  constructor(
    message: string,
    readonly recovery: string,
    readonly file?: string
  ) {
    super(message)
  }
}

function emitCheckError(error: CheckError): void {
  process.stderr.write(`${JSON.stringify(error)}\n`)
}

export function parseSemVer(value: string): SemVer | null {
  const m = value.match(SEMVER_RE)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : []
  }
}

function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Number(a) - Number(b)
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Semantic-version precedence: negative when `a` is lower, 0 when equal. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (core !== 0) return core
  // A version with a prerelease ranks below the same version without one.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const c = compareIdentifier(a.prerelease[i] ?? '', b.prerelease[i] ?? '')
    if (c !== 0) return c
  }
  return a.prerelease.length - b.prerelease.length
}

/** Parse a process definition's text; throws `Undecidable` naming the side it came from. */
export function parseProcessDefinition(text: string, side: 'base' | 'head'): ProcessDefinition {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    throw new Undecidable(
      `${PROCESS_FILE} at the ${side} is not valid YAML: ${(error as Error).message}`,
      `Fix the YAML in ${PROCESS_FILE}, then re-run this check.`,
      PROCESS_FILE
    )
  }
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // YAML reads `version: 2` or `version: 1.5` as a number; keep it so it is
  // reported as not a semantic version rather than as absent.
  const version = typeof doc.version === 'string' || typeof doc.version === 'number' ? String(doc.version).trim() : ''
  if (!version) {
    throw new Undecidable(
      `${PROCESS_FILE} at the ${side} has no version.`,
      `Give ${PROCESS_FILE} a semantic version (\`version: 1.2.3\`), then re-run this check.`,
      PROCESS_FILE
    )
  }
  if (!parseSemVer(version)) {
    throw new Undecidable(
      `${PROCESS_FILE} at the ${side} has version \`${version}\`, which is not a semantic version.`,
      `Write the version in ${PROCESS_FILE} as a semantic version (\`1.2.3\`), then re-run this check.`,
      PROCESS_FILE
    )
  }
  const flow = typeof doc.flow === 'string' ? doc.flow.trim() : ''
  const roles = Array.isArray(doc.roles) ? doc.roles : null
  if (!flow || !roles || roles.length === 0 || roles.some((r) => typeof r !== 'string' || !r.trim())) {
    throw new Undecidable(
      `${PROCESS_FILE} at the ${side} does not name a \`flow\` and a non-empty list of \`roles\`.`,
      `Declare \`flow\` and \`roles\` in ${PROCESS_FILE}, then re-run this check.`,
      PROCESS_FILE
    )
  }
  return { version, flow, roles: roles.map((r) => (r as string).trim()) }
}

function inFolder(relative: string): string {
  return posix.normalize(posix.join(PROCESS_FOLDER, relative)).replace(/\/+$/, '')
}

/**
 * The repository-relative files whose change alters how the process works,
 * other than `process.yaml`, which is judged by its content.
 */
export function governedFiles(head: ProcessDefinition): Set<string> {
  const files = new Set<string>([inFolder(head.flow), inFolder(BINDINGS_FILE)])
  for (const role of head.roles) {
    for (const file of ROLE_FILES) files.add(inFolder(posix.join(role, file)))
  }
  return files
}

/** True when the two texts differ in anything but their top-level `version` line. */
export function definitionChangedBeyondVersion(base: string, head: string): boolean {
  const strip = (text: string) =>
    text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !VERSION_LINE_RE.test(line))
      .join('\n')
  return strip(base) !== strip(head)
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

function resolveMergeBase(): string | null {
  const explicit = process.env.BASE_SHA?.trim()
  for (const ref of [explicit, 'origin/main', 'main']) {
    if (!ref) continue
    const base = git(['merge-base', 'HEAD', ref])?.trim()
    if (base) return base
  }
  return null
}

function decide(): { changed: string[]; base: string; head: string } | { skipped: true } {
  const mergeBase = resolveMergeBase()
  if (mergeBase === null) {
    throw new Undecidable(
      'Could not resolve a base to diff against (BASE_SHA, origin/main, main) — the process version could not be checked.',
      'Fetch the base branch (`git fetch origin main`) or set BASE_SHA, then re-run this check. An unresolvable base must never be treated as a pass.'
    )
  }

  const diff = git(['diff', '--name-only', '--no-renames', '--no-color', mergeBase, '--', `${PROCESS_FOLDER}/`])
  if (diff === null) {
    throw new Undecidable(
      `\`git diff ${mergeBase}\` failed — the process version could not be checked.`,
      'Run the git diff by hand to see the real error, fix the cause, and re-run this check.'
    )
  }
  const changedFiles = diff.split('\n').filter(Boolean)

  const root = git(['rev-parse', '--show-toplevel'])?.trim()
  const headPath = root ? posix.join(root, PROCESS_FILE) : PROCESS_FILE
  if (!existsSync(headPath)) {
    throw new Undecidable(
      `${PROCESS_FILE} is missing at the head.`,
      `Restore ${PROCESS_FILE}, then re-run this check.`,
      PROCESS_FILE
    )
  }
  const headText = readFileSync(headPath, 'utf8')
  const head = parseProcessDefinition(headText, 'head')

  const baseText = git(['show', `${mergeBase}:${PROCESS_FILE}`])
  if (baseText === null) {
    throw new Undecidable(
      `${PROCESS_FILE} is missing at the base ${mergeBase}.`,
      'The process definition must exist on the base branch for its version to be compared; check the base ref, then re-run this check.',
      PROCESS_FILE
    )
  }
  const base = parseProcessDefinition(baseText, 'base')

  const governed = governedFiles(head)
  const changed = changedFiles.filter((file) =>
    file === PROCESS_FILE ? definitionChangedBeyondVersion(baseText, headText) : governed.has(file)
  )
  if (changed.length === 0) return { skipped: true }
  return { changed, base: base.version, head: head.version }
}

function main(): void {
  let outcome: ReturnType<typeof decide>
  try {
    outcome = decide()
  } catch (error) {
    if (!(error instanceof Undecidable)) throw error
    emitCheckError({
      schema: 1,
      check: CHECK_NAME,
      severity: 'error',
      message: error.message,
      agent_recovery_prompt: error.recovery,
      ...(error.file ? { file: error.file } : {})
    })
    process.exit(1)
  }

  if ('skipped' in outcome) {
    process.stdout.write(`${CHECK_NAME}: skipped — no file governing how the process works changed.\n`)
    process.exit(0)
  }

  const baseVersion = parseSemVer(outcome.base) as SemVer
  const headVersion = parseSemVer(outcome.head) as SemVer
  if (compareSemVer(headVersion, baseVersion) > 0) {
    process.stdout.write(
      `${CHECK_NAME}: ${outcome.changed.length} governed file(s) changed and the version rose from ${outcome.base} to ${outcome.head}.\n`
    )
    process.exit(0)
  }

  for (const file of outcome.changed) {
    emitCheckError({
      schema: 1,
      check: CHECK_NAME,
      severity: 'error',
      message: `${file} changes how the process works, but the version in ${PROCESS_FILE} did not rise: base ${outcome.base}, head ${outcome.head}.`,
      agent_recovery_prompt: `Raise \`version\` in ${PROCESS_FILE} to a semantic version higher than ${outcome.base}, then re-run this check.`,
      file
    })
  }
  process.exit(1)
}

if (import.meta.main) main()
