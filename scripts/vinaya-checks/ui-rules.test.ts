import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isScanned, parseAddedLines, scanAddedLines, scanLine } from './ui-rules'

const PAGE = 'apps/vinaya-portal/src/app/page.tsx'
const LIB = 'apps/vinaya-portal/src/ui/components/button.tsx'
const rules = (text: string, file = PAGE) => scanLine(file, 1, text).map((f) => f.rule)

describe('forbidden', () => {
  test.each([
    ['<p className="text-green-500">', 'Tailwind palette colour class'],
    ['<p className="hover:bg-zinc-900/40">', 'Tailwind palette colour class'],
    ['<p className="border-amber-200">', 'Tailwind palette colour class'],
    ['<p className="bg-[#1a1610]">', 'arbitrary colour value'],
    ['<p className="text-[oklch(65%_0.17_145)]">', 'arbitrary colour value'],
    ['<p className="border-[rgb(1,2,3)]">', 'arbitrary colour value'],
    ['<p className="text-white">', 'absolute colour class'],
    ['<p className="bg-black/80">', 'absolute colour class'],
    ["<p style={{ color: '#fff' }}>", 'colour literal in a style'],
    ['<p style={{ background: "oklch(1 0 0)" }}>', 'colour literal in a style'],
    ['<path fill="#abc" />', 'colour literal in a style'],
    ['<path stroke="rgba(0,0,0,.5)" />', 'colour literal in a style'],
    ["<p style={{ '--brand': 'x' }}>", 'CSS variable declaration'],
    ['<p className="[--gap:4px]">', 'CSS variable declaration'],
    ["el.style.setProperty('--brand', v)", 'CSS variable declaration'],
    ["import { FaBeer } from 'react-icons/fa'", 'icon package other than lucide-react'],
    ["import { A } from '@heroicons/react/24/solid'", 'icon package other than lucide-react'],
    ["import { A } from '@phosphor-icons/react'", 'icon package other than lucide-react'],
    ["import { A } from '@tabler/icons-react'", 'icon package other than lucide-react'],
    ["import { A } from '@fortawesome/free-solid-svg-icons'", 'icon package other than lucide-react'],
    ["import { A } from '@radix-ui/react-icons'", 'icon package other than lucide-react'],
    ["import { A } from 'iconoir-react'", 'icon package other than lucide-react'],
    ["const A = require('react-icons/md')", 'icon package other than lucide-react'],
    ['<button onClick={f}>', 'raw interactive HTML element outside the component library'],
    ['<a href="/x">', 'raw interactive HTML element outside the component library'],
    ['<input', 'raw interactive HTML element outside the component library'],
    ['<textarea />', 'raw interactive HTML element outside the component library'],
    ['<select>', 'raw interactive HTML element outside the component library'],
    ['<details>', 'raw interactive HTML element outside the component library'],
    ['<dialog open>', 'raw interactive HTML element outside the component library']
  ])('%s', (text, rule) => {
    expect(rules(text)).toContain(rule)
  })

  test('colour literals and variable declarations in a stylesheet', () => {
    const css = 'apps/vinaya-portal/src/app/extra.css'
    expect(rules('a { color: #fff; }', css)).toContain('colour literal in a stylesheet')
    expect(rules('a { color: oklch(1 0 0); }', css)).toContain('colour literal in a stylesheet')
    expect(rules(':root { --brand: red; }', css)).toContain('CSS variable declaration')
  })

  test('a finding carries its file, line and the rule file', () => {
    const [finding] = scanLine(PAGE, 7, '<p className="text-white">')
    expect(finding).toMatchObject({ file: PAGE, line: 7, ruleFile: '.claude/rules/ui-theme-tokens.md' })
    const [raw] = scanLine(PAGE, 3, '<button>')
    expect(raw?.ruleFile).toBe('.claude/rules/ui-components.md')
  })
})

describe('allowed', () => {
  test.each([
    '<p className="bg-primary text-primary-foreground border-border">',
    '<p className="bg-primary/10 text-success border-success/40">',
    '<p className="text-transparent bg-current">',
    '<p className="bg-[var(--header-background)]">',
    '<p style={{ width: `${w}px`, background: `color-mix(in oklch, var(--primary) ${p}%, transparent)` }}>',
    '<p className="rounded-full rounded-none">',
    'const x = "is-blue-team-500"',
    "import { Check } from 'lucide-react'",
    "import { siGithub } from 'simple-icons'",
    "import { ELEMENT_ICONS } from '@/app/(site)/_components/icons/registry'",
    "import { Mark } from './icons/react-icons-like'",
    "import { Mark } from '../marks'",
    "import { NextLink } from '@/ui/lib/next-link'",
    '<Button variant="primary">',
    '<NextLink href="/x">',
    '// text-white is explained here',
    '{/* <button> in a comment */}',
    'const t = a < b && c > d'
  ])('%s', (text) => {
    expect(rules(text)).toEqual([])
  })

  test('raw elements are allowed inside the component library', () => {
    expect(rules('<button type="button">', LIB)).toEqual([])
    expect(rules('<a href="/x">', LIB)).toEqual([])
  })

  test('exempt files hold colour literals and variable declarations', () => {
    for (const file of [
      'apps/vinaya-portal/src/ui/styles/globals.css',
      'apps/vinaya-portal/src/cms/utils/theme.ts',
      'apps/vinaya-portal/src/ui/lib/preview-theme-utils.ts',
      'apps/vinaya-portal/src/process/lifecycle/lifecycle-scene.js'
    ]) {
      expect(rules(':root { --x: #fff; color: oklch(1 0 0) } text-white', file)).toEqual([])
    }
  })

  test('files outside the web apps and non-code files are not scanned', () => {
    expect(isScanned('apps/cli/src/index.ts')).toBe(false)
    expect(isScanned('apps/vinaya-portal/README.md')).toBe(false)
    expect(isScanned('apps/vinaya-portal/src/cms/utils/theme-corpus.fixture.json')).toBe(false)
    expect(isScanned(PAGE)).toBe(true)
    expect(isScanned('apps/vinaya-other/src/x.ts')).toBe(true)
  })
})

describe('added lines', () => {
  test('parseAddedLines numbers only added lines', () => {
    const diff = [
      `diff --git a/${PAGE} b/${PAGE}`,
      `--- a/${PAGE}`,
      `+++ b/${PAGE}`,
      '@@ -3,0 +4,2 @@',
      '+one',
      '+two',
      '@@ -10 +12 @@',
      '-old',
      '+three'
    ].join('\n')
    expect(parseAddedLines(diff)).toEqual([
      { file: PAGE, line: 4, text: 'one' },
      { file: PAGE, line: 5, text: 'two' },
      { file: PAGE, line: 12, text: 'three' }
    ])
  })

  test('removed lines are never scanned', () => {
    const diff = [
      `+++ b/${PAGE}`,
      '@@ -1 +1 @@',
      '-<p className="text-white">',
      '+<p className="text-foreground">'
    ].join('\n')
    expect(scanAddedLines(parseAddedLines(diff))).toEqual([])
  })
})

describe('the check run against a git branch', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-rules-test-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  const write = (file: string, body: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), body)
  }
  const run = () =>
    Bun.spawnSync(['bun', join(import.meta.dir, 'ui-rules.ts')], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BASE_SHA: 'main' },
      stderr: 'pipe',
      stdout: 'pipe'
    })

  test('reports an added violation, never a pre-existing one', () => {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t.t')
    git('config', 'user.name', 't')
    git('config', 'commit.gpgsign', 'false')
    write(PAGE, 'export const a = <p className="text-white">old</p>\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'feature')

    write(
      PAGE,
      'export const a = <p className="text-white">old</p>\nexport const b = <p className="text-foreground">ok</p>\n'
    )
    git('commit', '-qam', 'clean change')
    const clean = run()
    expect(clean.exitCode).toBe(0)

    write(
      PAGE,
      'export const a = <p className="text-white">old</p>\nexport const b = <p className="text-foreground">ok</p>\nexport const c = <p className="bg-zinc-900">bad</p>\n'
    )
    git('commit', '-qam', 'bad change')
    const bad = run()
    expect(bad.exitCode).toBe(1)
    const findings = bad.stderr
      .toString()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      check: 'atta-labs/ui-rules',
      file: PAGE,
      line: 3,
      schema: 1,
      severity: 'error'
    })
    expect(findings[0].message).toContain('Tailwind palette colour class')
  })
})
