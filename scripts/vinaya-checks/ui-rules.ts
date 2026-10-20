#!/usr/bin/env bun
/**
 * atta-labs/ui-rules — a custom vinaya check that refuses UI code breaking the
 * portal's UI rules (`.claude/rules/ui-components.md` and
 * `.claude/rules/ui-theme-tokens.md`).
 *
 * Contract: emit one JSON line on stderr per finding via `emitCheckError`,
 * then exit 0 (pass) or 1 (findings). The RUNNER enforces the timeout. This
 * file is standalone (no import from the vinaya CLI's own source tree).
 *
 * Diff-scoped: only the lines a branch ADDS (against its merge base with the
 * base ref, staged and unstaged edits included) in web-app files under
 * `apps/vinaya-*` are scanned. Violations already in the portal are never
 * reported, so they cannot block an unrelated pull request.
 *
 * Findings:
 *   1. Tailwind palette classes             text-green-500, hover:bg-zinc-900
 *   2. Arbitrary colour values              bg-[#1a1610], text-[oklch(...)]
 *   3. Absolute colours                     text-white, bg-black/80
 *   4. Colour literals in a style           color: '#fff', fill="rgb(...)", a CSS hex
 *   5. CSS variable declarations            --x: 1px, '--x': v, setProperty('--x', v)
 *   6. Icon packages beyond lucide-react    react-icons, @heroicons/*, ...
 *   7. Raw interactive HTML elements        <button>, <a>, <input>, ... outside src/ui
 *
 * `var(--x)` is a use, never a declaration, and is not flagged.
 */

import { execFileSync } from 'node:child_process'

type CheckError = {
  schema: 1
  check: string
  severity: 'error' | 'warning'
  message: string
  agent_recovery_prompt: string
  file?: string
  line?: number
}

export type Finding = {
  file: string
  line: number
  snippet: string
  rule: string
  ruleFile: string
}

export type AddedLine = { file: string; line: number; text: string }

const CHECK_NAME = 'atta-labs/ui-rules'
const THEME_RULES = '.claude/rules/ui-theme-tokens.md'
const COMPONENT_RULES = '.claude/rules/ui-components.md'

function emitCheckError(error: CheckError): void {
  process.stderr.write(`${JSON.stringify(error)}\n`)
}

const COLOR_PROPS = [
  'text',
  'bg',
  'border',
  'ring',
  'from',
  'to',
  'via',
  'placeholder',
  'decoration',
  'outline',
  'caret',
  'fill',
  'stroke',
  'divide',
  'accent',
  'shadow'
].join('|')

const PALETTE = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose'
].join('|')

const STYLE_COLOR_PROPS = [
  'color',
  'background',
  'backgroundColor',
  'backgroundImage',
  'borderColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'outlineColor',
  'caretColor',
  'fill',
  'stroke',
  'stopColor',
  'floodColor',
  'textDecorationColor'
].join('|')

// The lookbehind rejects matches inside identifiers (`is-blue-team-500`) while
// still allowing a variant prefix (`hover:bg-red-500`).
const PALETTE_RE = new RegExp(`(?<![\\w-])(?:${COLOR_PROPS})-(?:${PALETTE})-\\d{2,3}(?:\\/\\d{1,3})?(?![\\w-])`, 'g')
const ARBITRARY_HEX_RE = new RegExp(`(?<![\\w-])(?:${COLOR_PROPS})-\\[#[0-9a-fA-F]{3,8}\\]`, 'g')
const ARBITRARY_FUNC_RE = new RegExp(`(?<![\\w-])(?:${COLOR_PROPS})-\\[(?:oklch|hsla?|rgba?)\\(`, 'g')
const ABSOLUTE_RE = new RegExp(`(?<![\\w-])(?:${COLOR_PROPS})-(?:white|black)(?:\\/\\d{1,3})?(?![\\w-])`, 'g')
// A colour-bearing style property or SVG attribute followed by a quoted literal.
const STYLE_LITERAL_RE = new RegExp(
  `(?:${STYLE_COLOR_PROPS})\\s*[:=]\\s*\\{?\\s*['"\`]\\s*(?:#[0-9a-fA-F]{3,8}|(?:oklch|hsla?|rgba?)\\()`,
  'g'
)
const CSS_HEX_RE = /(?<![\w&])#[0-9a-fA-F]{3,8}\b/g
const CSS_FUNC_RE = /\b(?:oklch|hsla?|rgba?)\s*\(/g

// `--x:` as a declaration: bare in a stylesheet or a Tailwind `[--x:v]`, or as a
// quoted object key. `var(--x)` has no colon after the name and never matches.
const VARIABLE_DECLARATION_RE = /(?<![\w-])--[a-zA-Z][\w-]*['"]?\s*:/g
const SET_PROPERTY_RE = /setProperty\(\s*['"`]--/g

const FORBIDDEN_ICON_PACKAGES = [
  /^react-icons(?:\/|$)/,
  /^@heroicons\//,
  /^@phosphor-icons\//,
  /^@tabler\//,
  /^@fortawesome\//,
  /^@radix-ui\/react-icons(?:\/|$)/,
  /^iconoir-react(?:\/|$)/
]
const IMPORT_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"]([^'"]+)['"]/g

const RAW_ELEMENT_RE = /<(button|a|input|textarea|select|option|dialog|details|summary)(?=[\s>/]|$)/g

const UI_FILE_RE = /\.(tsx|jsx|ts|js|mts|cts|mjs|cjs|css)$/
const JSX_FILE_RE = /\.(tsx|jsx)$/
const WEB_APP_RE = /^apps\/vinaya-[^/]+\//

// The component library, where Ariakit components are built from raw elements.
const COMPONENT_LIBRARY_RE = /^apps\/vinaya-[^/]+\/src\/ui\//

// Files allowed to hold colour literals and variable declarations, and files
// no rule applies to.
const EXEMPT_RES = [
  // The global stylesheet: its `@theme` block maps the CMS theme's variables.
  /^apps\/vinaya-[^/]+\/src\/ui\/styles\//,
  // The CMS theme renderer.
  /^apps\/vinaya-[^/]+\/src\/cms\//,
  // The preview-theme helper, which writes the theme's variables at runtime.
  /^apps\/vinaya-[^/]+\/src\/ui\/lib\/preview-theme-utils\.[cm]?[jt]sx?$/,
  // Verbatim upstream pastes and vendored three.js files root Biome ignores.
  /^apps\/vinaya-[^/]+\/src\/ui\/components\/table\/installed\.tsx$/,
  /^apps\/vinaya-[^/]+\/src\/ui\/libraries\/[^/]+\/installed\//,
  /^apps\/vinaya-[^/]+\/src\/process\/lifecycle\/lifecycle-scene\.js$/,
  /^apps\/vinaya-[^/]+\/src\/process\/flows\/.*\.js$/,
  /^apps\/vinaya-[^/]+\/src\/app\/.*\/hero-canvas\/[^/]+\.js$/,
  /^apps\/vinaya-[^/]+\/src\/app\/.*\/canvas\/[^/]+\.js$/,
  /^apps\/vinaya-[^/]+\/src\/app\/.*\/fabric-wall\.js$/,
  /^apps\/vinaya-[^/]+\/design\/.*\.js$/
]

export function isScanned(file: string): boolean {
  return WEB_APP_RE.test(file) && UI_FILE_RE.test(file) && !EXEMPT_RES.some((re) => re.test(file))
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('{/*')
}

function collect(
  out: Finding[],
  file: string,
  line: number,
  text: string,
  re: RegExp,
  rule: string,
  ruleFile: string
): void {
  re.lastIndex = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ file, line, snippet: m[0], rule, ruleFile })
  }
}

export function scanLine(file: string, line: number, text: string): Finding[] {
  const out: Finding[] = []
  if (!isScanned(file)) return out
  if (isCommentLine(text.trim())) return out

  const isCss = file.endsWith('.css')
  if (isCss) {
    collect(out, file, line, text, CSS_HEX_RE, 'colour literal in a stylesheet', THEME_RULES)
    collect(out, file, line, text, CSS_FUNC_RE, 'colour literal in a stylesheet', THEME_RULES)
    collect(out, file, line, text, VARIABLE_DECLARATION_RE, 'CSS variable declaration', THEME_RULES)
    return out
  }

  collect(out, file, line, text, PALETTE_RE, 'Tailwind palette colour class', THEME_RULES)
  collect(out, file, line, text, ARBITRARY_HEX_RE, 'arbitrary colour value', THEME_RULES)
  collect(out, file, line, text, ARBITRARY_FUNC_RE, 'arbitrary colour value', THEME_RULES)
  collect(out, file, line, text, ABSOLUTE_RE, 'absolute colour class', THEME_RULES)
  collect(out, file, line, text, STYLE_LITERAL_RE, 'colour literal in a style', THEME_RULES)
  collect(out, file, line, text, VARIABLE_DECLARATION_RE, 'CSS variable declaration', THEME_RULES)
  collect(out, file, line, text, SET_PROPERTY_RE, 'CSS variable declaration', THEME_RULES)

  IMPORT_SPECIFIER_RE.lastIndex = 0
  for (let m = IMPORT_SPECIFIER_RE.exec(text); m !== null; m = IMPORT_SPECIFIER_RE.exec(text)) {
    const specifier = m[1] ?? ''
    if (FORBIDDEN_ICON_PACKAGES.some((re) => re.test(specifier))) {
      out.push({ file, line, snippet: specifier, rule: 'icon package other than lucide-react', ruleFile: THEME_RULES })
    }
  }

  if (JSX_FILE_RE.test(file) && !COMPONENT_LIBRARY_RE.test(file)) {
    collect(
      out,
      file,
      line,
      text,
      RAW_ELEMENT_RE,
      'raw interactive HTML element outside the component library',
      COMPONENT_RULES
    )
  }
  return out
}

/**
 * Parse `git diff --unified=0` output into per-file added-line records. Each
 * hunk header `@@ -a,b +c,d @@` gives the first new line number; added lines
 * count up from there.
 */
export function parseAddedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = []
  let file: string | null = null
  let line = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null
      continue
    }
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null
      continue
    }
    if (raw.startsWith('--- ')) continue
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      line = Number.parseInt(hunk[1] ?? '0', 10)
      continue
    }
    if (!file) continue
    if (raw.startsWith('+')) {
      out.push({ file, line, text: raw.slice(1) })
      line++
    } else if (raw.startsWith(' ')) {
      line++
    }
  }
  return out
}

export function scanAddedLines(added: AddedLine[]): Finding[] {
  return added.flatMap((a) => scanLine(a.file, a.line, a.text))
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

function main(): void {
  const base = resolveMergeBase()
  if (base === null) {
    emitCheckError({
      schema: 1,
      check: CHECK_NAME,
      severity: 'error',
      message:
        'Could not resolve a base to diff against (BASE_SHA, origin/main, main) — the UI rules could not be checked.',
      agent_recovery_prompt:
        'Fetch the base branch (`git fetch origin main`) or set BASE_SHA, then re-run this check. An unresolvable base must never be treated as a clean scan.'
    })
    process.exit(1)
  }

  const diff = git(['diff', '--unified=0', '--no-color', base, '--', 'apps/'])
  if (diff === null) {
    emitCheckError({
      schema: 1,
      check: CHECK_NAME,
      severity: 'error',
      message: `\`git diff ${base}\` failed — the UI rules could not be checked.`,
      agent_recovery_prompt: 'Run the git diff by hand to see the real error, fix the cause, and re-run this check.'
    })
    process.exit(1)
  }

  const findings = scanAddedLines(parseAddedLines(diff))
  for (const f of findings) {
    emitCheckError({
      schema: 1,
      check: CHECK_NAME,
      severity: 'error',
      message: `${f.rule}: \`${f.snippet}\``,
      agent_recovery_prompt: `Rewrite this added line to follow ${f.ruleFile} (${f.rule}), then re-run this check. Only lines the branch adds are scanned, so existing code is not at fault.`,
      file: f.file,
      line: f.line
    })
  }
  process.exit(findings.length === 0 ? 0 : 1)
}

if (import.meta.main) main()
