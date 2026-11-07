#!/usr/bin/env bun
/**
 * One-time proof that moving the doctrine out of its old root folder changed
 * nothing but what the rewrite table records. It is bound to the commit the
 * recording names as its base, never a standing test: a later doctrine edit
 * is expected to make it fail, and the script and its two fixtures are
 * deleted once the move has landed. Nothing imports it and continuous
 * integration never runs it.
 *
 * Modes:
 *   --record [--at <commit>]  record every doctrine output from the working
 *                             tree, or from a detached worktree of <commit>
 *   --table                   every moved file equals its base content with
 *                             the table applied
 *   --source                  every recorded output, table applied, equals
 *                             what the source tree prints today
 *   --packed                  the same, from a packed install outside the
 *                             repository
 *
 * Fixtures: `fixtures/doctrine-move-proof/output-recording.json` (the
 * recorded outputs and their base commit) and
 * `fixtures/doctrine-move-proof/rewrite-table.json` (every textual change).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'

const CLI_ROOT = join(import.meta.dir, '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')
const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'doctrine-move-proof')
const RECORDING_PATH = join(FIXTURE_DIR, 'output-recording.json')
const TABLE_PATH = join(FIXTURE_DIR, 'rewrite-table.json')

/** Text a term row must never match: environment variables, file and forge markers, and the old root path. */
const PROTECTED_SAMPLES = ['AEG_REPO', 'AEG:CLAIM', '<!-- AEG:', 'aeg:', 'aeg-root'] as const

type MoveRow = { from: string; to: string }
type LinkRow = { file: string; from: string; to: string }
type RegexRow = { pattern: string; replacement: string }
type RewriteTable = {
  /** Repository-relative old path to repository-relative new path, one row per moved doctrine file. */
  moves: MoveRow[]
  /** Literal path citations in text, applied in order before the root row. */
  paths: MoveRow[]
  /** Literal relative Markdown links, scoped to the old file that carries them. */
  links: LinkRow[]
  /** The old root segment, a regular expression applied after the path rows. */
  root: RegexRow
  /** Word-bounded term rewrites, applied last. */
  terms: RegexRow[]
}

type RecordedEntry = { text: string; file?: string }
type Recording = { base: string; entries: Record<string, RecordedEntry> }

function fail(message: string): never {
  process.stderr.write(`doctrine-move-proof: ${message}\n`)
  process.exit(1)
}

function git(args: string[], cwd: string = REPO_ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 })
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function readTable(): RewriteTable {
  const table = JSON.parse(readFileSync(TABLE_PATH, 'utf8')) as RewriteTable
  // Refuse before applying anything: a term row that matches a marker, an
  // environment variable or a path would predict a change to text `init`
  // keeps as it is.
  for (const row of table.terms) {
    const re = new RegExp(row.pattern)
    for (const sample of PROTECTED_SAMPLES) {
      if (re.test(sample)) fail(`term row /${row.pattern}/ matches protected text "${sample}" — refusing the table`)
    }
  }
  return table
}

function replaceAll(text: string, from: string, to: string): string {
  return text.split(from).join(to)
}

/** The table applied to one text; `file` is the old repository-relative path of the doctrine file the text came from, when it came from one. */
function applyTable(table: RewriteTable, text: string, file?: string): string {
  let out = text
  if (file !== undefined) {
    for (const link of table.links) if (link.file === file) out = replaceAll(out, link.from, link.to)
  }
  for (const row of table.paths) out = replaceAll(out, row.from, row.to)
  out = out.replace(new RegExp(table.root.pattern, 'g'), table.root.replacement)
  for (const row of table.terms) out = out.replace(new RegExp(row.pattern, 'g'), row.replacement)
  return out
}

function readVersion(cliRoot: string): string {
  return (JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')) as { version: string }).version
}

function normalizeVersion(text: string, version: string): string {
  return replaceAll(text, version, '<version>')
}

/** Runs one CLI invocation, returning stdout; a non-zero exit is a failure of the proof. */
type Runner = (args: string[], cwd: string) => string

function makeRunner(command: string, entry: string, env: NodeJS.ProcessEnv = process.env): Runner {
  return (args, cwd) => {
    const result = spawnSync(command, [entry, ...args], { cwd, encoding: 'utf8', env, maxBuffer: 1 << 26 })
    if (result.status !== 0) {
      fail(`\`${command} ${entry} ${args.join(' ')}\` in ${cwd} exited ${result.status}: ${result.stderr}`)
    }
    return result.stdout
  }
}

function listFiles(dir: string, base: string = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) listFiles(full, base, out)
    else out.push(relative(base, full))
  }
  return out
}

function emptyGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'doctrine-move-proof-repo-'))
  git(['init', '-q'], dir)
  return dir
}

/**
 * Every recorded output, keyed by name. `doctrineCwd` is where the doctrine
 * commands run (the repository for a source run, an empty repository for a
 * packed run); `init` always runs in a fresh empty repository. `oldLayout`
 * marks a run against the pre-move tree, whose entries carry the old file
 * they came from so the table's scoped link rows can be applied to them.
 */
function collectOutputs(
  run: Runner,
  doctrineCwd: string,
  version: string,
  oldLayout: boolean
): Record<string, RecordedEntry> {
  const entries: Record<string, RecordedEntry> = {}
  const json = JSON.parse(run(['doctrine', '--json'], doctrineCwd)) as {
    schema: number
    data: { root: string; entry: string }
  }
  const root = json.data.root
  const frontDoor = run(['doctrine'], doctrineCwd).trim()
  const frontDoorRelative = relative(root, frontDoor)
  const frontDoorFile = oldLayout ? `aeg-root/${frontDoorRelative}` : undefined
  entries['front-door:content'] = { text: readFileSync(frontDoor, 'utf8'), file: frontDoorFile }
  entries['front-door:root-segment'] = { text: basename(root) }
  entries['front-door:entry'] = { text: frontDoorRelative }
  entries['json:schema'] = { text: String(json.schema) }
  entries['json:root-segment'] = { text: basename(root) }
  entries['json:entry'] = { text: relative(root, json.data.entry) }

  for (const role of listNames(doctrineCwd, '--role')) {
    entries[`role:${role}`] = {
      text: run(['doctrine', '--role', role, '--print'], doctrineCwd),
      file: oldLayout ? `aeg-root/roles/${role}.md` : undefined
    }
  }
  for (const template of listNames(doctrineCwd, '--template')) {
    entries[`template:${template}`] = {
      text: run(['doctrine', '--template', template, '--print'], doctrineCwd),
      file: oldLayout ? `aeg-root/templates/${template}-template.md` : undefined
    }
  }

  const initRepo = emptyGitRepo()
  run(['init', '--yes'], initRepo)
  for (const path of listFiles(initRepo)) {
    entries[`init:${path}`] = { text: readFileSync(join(initRepo, path), 'utf8') }
  }

  for (const entry of Object.values(entries)) entry.text = normalizeVersion(entry.text, version)
  return entries
}

/** The valid names a `--role`/`--template` refusal lists — the command's own enumeration, not a copy of it. */
function listNames(cwd: string, flag: '--role' | '--template'): string[] {
  const result = currentRefusal(flag, cwd)
  const match = /Valid (?:role|template) names: (.*)$/m.exec(result)
  if (match === null) fail(`no name list in the ${flag} refusal: ${result}`)
  return (match[1] ?? '').split(', ').filter((name) => name.length > 0)
}

let refusalRunner: ((flag: string, cwd: string) => string) | null = null
function currentRefusal(flag: string, cwd: string): string {
  if (refusalRunner === null) fail('no refusal runner configured')
  return refusalRunner(flag, cwd)
}

function makeRefusalRunner(command: string, entry: string): (flag: string, cwd: string) => string {
  return (flag, cwd) => {
    const result = spawnSync(command, [entry, 'doctrine', flag, 'doctrine-move-proof-unknown'], {
      cwd,
      encoding: 'utf8'
    })
    return result.stderr
  }
}

function record(at: string | undefined): void {
  if (at === undefined) {
    const base = git(['rev-parse', 'HEAD']).trim()
    if (git(['status', '--porcelain', '--', 'aeg-root']).trim() !== '')
      fail('the doctrine has uncommitted changes — record from a clean tree')
    const entry = join(CLI_ROOT, 'src', 'index.ts')
    refusalRunner = makeRefusalRunner(process.execPath, entry)
    const entries = collectOutputs(makeRunner(process.execPath, entry), REPO_ROOT, readVersion(CLI_ROOT), true)
    writeRecording({ base, entries })
    return
  }
  const base = git(['rev-parse', '--verify', `${at}^{commit}`]).trim()
  const worktree = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'doctrine-move-proof-at-')), 'tree')
  git(['worktree', 'add', '--detach', worktree, base])
  try {
    const install = spawnSync(process.execPath, ['install', '--frozen-lockfile'], { cwd: worktree, encoding: 'utf8' })
    if (install.status !== 0) fail(`bun install --frozen-lockfile in the recording worktree failed: ${install.stderr}`)
    const entry = join(worktree, 'apps', 'cli', 'src', 'index.ts')
    refusalRunner = makeRefusalRunner(process.execPath, entry)
    const entries = collectOutputs(
      makeRunner(process.execPath, entry),
      worktree,
      readVersion(join(worktree, 'apps', 'cli')),
      true
    )
    writeRecording({ base, entries })
  } finally {
    git(['worktree', 'remove', '--force', worktree])
  }
}

function writeRecording(recording: Recording): void {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(RECORDING_PATH, `${JSON.stringify(recording, null, 2)}\n`)
  console.log(`doctrine-move-proof: recorded ${Object.keys(recording.entries).length} entries at ${recording.base}`)
}

function readRecording(): Recording {
  if (!existsSync(RECORDING_PATH)) fail(`no recording at ${RECORDING_PATH} — run --record first`)
  return JSON.parse(readFileSync(RECORDING_PATH, 'utf8')) as Recording
}

/** The recorded entry with the table applied — what the moved tree must print. */
function expected(table: RewriteTable, name: string, entry: RecordedEntry): string {
  if (name.endsWith(':root-segment')) return applyTable(table, entry.text)
  if (name === 'front-door:entry' || name === 'json:entry') {
    // An old root-relative path becomes the new process-relative path.
    return applyTable(table, `aeg-root/${entry.text}`)
  }
  return applyTable(table, entry.text, entry.file)
}

function compare(label: string, actual: Record<string, RecordedEntry>): void {
  const table = readTable()
  const recording = readRecording()
  const differing: string[] = []
  const names = new Set([...Object.keys(recording.entries), ...Object.keys(actual)])
  for (const name of [...names].sort()) {
    const recorded = recording.entries[name]
    const now = actual[name]
    if (recorded === undefined || now === undefined) {
      differing.push(`${name} (${recorded === undefined ? 'not recorded' : 'not produced'})`)
      continue
    }
    if (sha256(expected(table, name, recorded)) !== sha256(now.text)) differing.push(name)
  }
  if (differing.length > 0) fail(`${label}: ${differing.length} entr(y/ies) differ:\n  ${differing.join('\n  ')}`)
  console.log(`doctrine-move-proof ${label}: all ${names.size} recorded entries match by hash`)
}

function checkTable(): void {
  const table = readTable()
  const { base } = readRecording()
  const mergeBase = git(['merge-base', 'origin/main', 'HEAD']).trim()
  const changed = git(['diff', '--name-only', base, mergeBase, '--', 'aeg-root']).trim()
  if (changed !== '') {
    fail(
      `the doctrine changed on the default branch after the recording's base ${base}; re-record with --record --at "$(git merge-base origin/main HEAD)". Changed:\n  ${changed.split('\n').join('\n  ')}`
    )
  }
  const differing: string[] = []
  for (const move of table.moves) {
    const before = git(['show', `${base}:${move.from}`])
    const target = join(REPO_ROOT, move.to)
    if (!existsSync(target)) {
      differing.push(`${move.to} (missing)`)
      continue
    }
    if (existsSync(join(REPO_ROOT, move.from))) differing.push(`${move.from} (still present at its old path)`)
    if (applyTable(table, before, move.from) !== readFileSync(target, 'utf8')) differing.push(move.to)
  }
  if (differing.length > 0) fail(`--table: ${differing.length} file(s) differ:\n  ${differing.join('\n  ')}`)
  console.log(
    `doctrine-move-proof --table: all ${table.moves.length} moved files equal their base content with the table applied`
  )
}

function checkSource(): void {
  const entry = join(CLI_ROOT, 'src', 'index.ts')
  refusalRunner = makeRefusalRunner(process.execPath, entry)
  compare('--source', collectOutputs(makeRunner(process.execPath, entry), REPO_ROOT, readVersion(CLI_ROOT), false))
}

function checkPacked(): void {
  const build = (args: string[]): void => {
    const result = spawnSync(process.execPath, args, { cwd: CLI_ROOT, encoding: 'utf8' })
    if (result.status !== 0) fail(`bun ${args.join(' ')} failed: ${result.stderr}`)
  }
  build(['scripts/build.ts'])
  build(['scripts/bundle-doctrine.ts'])
  const work = mkdtempSync(join(tmpdir(), 'doctrine-move-proof-packed-'))
  const npmCache = mkdtempSync(join(tmpdir(), 'doctrine-move-proof-npm-cache-'))
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', work], {
    cwd: CLI_ROOT,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache }
  })
  if (pack.status !== 0) fail(`npm pack failed: ${pack.stderr}`)
  const tarball = join(work, pack.stdout.trim().split('\n').pop() ?? '')
  const installRoot = join(work, 'install')
  const pkgDir = join(installRoot, 'node_modules', '@attalabs', 'vinaya')
  mkdirSync(pkgDir, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', pkgDir, '--strip-components=1'])
  const manifest = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (spec.startsWith('workspace:')) continue
    const link = join(installRoot, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(REPO_ROOT, 'node_modules', name), link)
  }
  const entry = join(pkgDir, 'dist', 'index.js')
  refusalRunner = makeRefusalRunner('node', entry)
  compare('--packed', collectOutputs(makeRunner('node', entry), emptyGitRepo(), readVersion(CLI_ROOT), false))
}

function main(argv: string[]): void {
  const mode = argv[0]
  if (mode === '--record') {
    const atIndex = argv.indexOf('--at')
    record(atIndex === -1 ? undefined : (argv[atIndex + 1] ?? fail('--at needs a commit')))
  } else if (mode === '--table') checkTable()
  else if (mode === '--source') checkSource()
  else if (mode === '--packed') checkPacked()
  else fail('usage: doctrine-move-proof.ts --record [--at <commit>] | --table | --source | --packed')
}

main(process.argv.slice(2))
