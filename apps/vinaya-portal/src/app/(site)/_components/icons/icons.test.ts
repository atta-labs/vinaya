import { describe, expect, it } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOCS_NAV } from '../../docs/_lib/portal-docs'
import { ELEMENT_ICONS, iconForHref, iconForName, iconForPage } from './registry'

function render(key: keyof typeof ELEMENT_ICONS, still = true) {
  return renderToStaticMarkup(createElement(ELEMENT_ICONS[key], { still }))
}

function svg(key: keyof typeof ELEMENT_ICONS) {
  return new JSDOM(render(key)).window.document.querySelector('svg')!
}

describe('custom icon rendering', () => {
  it('keeps nested subject accents at the viewBox-scaled family weight', () => {
    for (const key of ['log', 'thinking'] as const) {
      const drawing = svg(key)
      const box = drawing.getAttribute('viewBox')!.split(' ').map(Number)
      const accent = drawing.querySelector('[data-weight="mark"]')!
      expect(Number(accent.getAttribute('stroke-width'))).toBeCloseTo((2.5 * Math.max(box[2]!, box[3]!)) / 56)
    }
  })

  it('compensates scaled role signs without thickening the agent frame', () => {
    const drawing = svg('architect')
    const sign = drawing.querySelector('[data-role-sign]')!
    const accent = sign.querySelector('[data-weight="mark"]')!
    const frameWeight = Number(drawing.querySelector('g')!.getAttribute('stroke-width'))
    expect(Number(sign.getAttribute('stroke-width')) * 0.80769).toBeCloseTo(frameWeight)
    expect(Number(accent.getAttribute('stroke-width')) * 0.80769).toBeCloseTo(frameWeight * 1.25)
  })

  it('renders the complete still drawings without animation transforms or dash hiding', () => {
    expect(Object.keys(ELEMENT_ICONS)).toHaveLength(29)
    for (const key of Object.keys(ELEMENT_ICONS) as (keyof typeof ELEMENT_ICONS)[]) {
      const drawing = svg(key)
      expect(drawing.querySelector('[style]')).toBeNull()
      expect(drawing.querySelector('[stroke-dasharray]')).toBeNull()
    }
    expect(render('log', false)).not.toEqual(render('log'))
    expect(render('operator', false)).not.toEqual(render('operator'))
  })

  it('shows one dot in each cell, and no feature signs, when still', () => {
    const drawing = svg('features')
    expect(drawing.querySelectorAll('circle')).toHaveLength(3)
    expect(drawing.querySelectorAll('circle.fill-ring')).toHaveLength(1)
    expect(drawing.querySelectorAll('[opacity]')).toHaveLength(0)
  })

  it('keeps the process accent on the joining line and the still sign on Architect', () => {
    const drawing = svg('vinaya-process')
    expect(drawing.querySelectorAll('.stroke-ring')).toHaveLength(1)
    expect(drawing.querySelector('.stroke-ring')!.getAttribute('d')).toBe('M2.59 33H8.41M47.59 33H53.41')
    expect(drawing.querySelectorAll('[data-role-sign]')).toHaveLength(1)
    expect(drawing.querySelector('[data-role-sign] path')!.getAttribute('d')).toBe('M20 40V16')
  })

  it('renders the same still drawings when the browser requests reduced motion', () => {
    // An isolated browser environment lets Motion read the actual media query at module initialization.
    const registry = new URL('./registry.ts', import.meta.url).href
    const child = Bun.spawnSync(
      [
        process.execPath,
        '--eval',
        `
      import { JSDOM } from 'jsdom'
      import { createElement } from 'react'
      import { renderToStaticMarkup } from 'react-dom/server'
      const dom = new JSDOM('')
      globalThis.window = dom.window
      globalThis.document = dom.window.document
      window.matchMedia = () => ({ matches: true, addEventListener() {} })
      const { ELEMENT_ICONS } = await import(${JSON.stringify(registry)})
      console.log(JSON.stringify(Object.fromEntries(Object.entries(ELEMENT_ICONS).map(([key, Icon]) =>
        [key, renderToStaticMarkup(createElement(Icon))]
      ))))
    `
      ],
      { cwd: new URL('../../../../../..', import.meta.url).pathname }
    )
    expect(child.exitCode).toBe(0)
    const reduced = JSON.parse(child.stdout.toString())
    for (const key of Object.keys(ELEMENT_ICONS) as (keyof typeof ELEMENT_ICONS)[]) {
      expect(reduced[key]).toEqual(render(key))
    }
  })

  it('maps process phases and omits retired parts from docs artwork', () => {
    expect(iconForHref('/docs/process/thinking')).toBe(ELEMENT_ICONS.thinking)
    expect(iconForHref('/docs/process/executing')).toBe(ELEMENT_ICONS.executing)
    expect(iconForHref('/docs/process/retrospecting')).toBe(ELEMENT_ICONS.retrospecting)
    expect(iconForHref('/docs/features/log/event-contract')).toBeUndefined()
    expect(iconForHref('/docs/features/studio/mission-control')).toBeUndefined()
    expect(iconForHref('/docs/features/configuration/trust')).toBeUndefined()
  })

  it('finds the icon a product, agent or subject name names, and none for any other name', () => {
    expect(iconForName('Log')).toBe(ELEMENT_ICONS.log)
    expect(iconForName('Self-improvement')).toBe(ELEMENT_ICONS['self-improvement'])
    expect(iconForName('Self-improve')).toBe(ELEMENT_ICONS['self-improvement'])
    expect(iconForName('The Vinaya harness')).toBe(ELEMENT_ICONS['vinaya-harness'])
    expect(iconForName('The Vinaya process')).toBe(ELEMENT_ICONS['vinaya-process'])
    expect(iconForName('Dev Process')).toBe(ELEMENT_ICONS['dev-process'])
    expect(iconForName('Security Reviewer')).toBe(ELEMENT_ICONS['security-reviewer'])
    expect(iconForName(' Tranche Archivist ')).toBe(ELEMENT_ICONS['tranche-archivist'])
    expect(iconForName('Using it')).toBe(ELEMENT_ICONS['using-it'])
    expect(iconForName('Start')).toBe(ELEMENT_ICONS['get-started'])
    for (const name of ['Principal', 'Overview', 'Architect → Planner', 'Event contract', 'constructor', '']) {
      expect(iconForName(name)).toBeUndefined()
    }
  })

  it('gives every docs sidebar section and docs set its icon by name', () => {
    for (const group of DOCS_NAV) {
      expect(iconForName(group.title)).toBeDefined()
      for (const section of group.sections) expect(iconForName(section.title)).toBeDefined()
    }
  })

  it('gives a docs page the icon of its address, else of its title', () => {
    expect(iconForPage({ href: '/docs/start', title: 'Overview' })).toBe(ELEMENT_ICONS['vinaya-harness'])
    expect(iconForPage({ href: '/docs/process/roles', title: 'Roles' })).toBe(ELEMENT_ICONS.agent)
    expect(iconForPage({ href: '/docs/process/integration', title: 'Integration' })).toBe(ELEMENT_ICONS.integration)
    expect(iconForPage({ href: '/docs/process/checks', title: 'Checks catalog' })).toBeUndefined()
  })

  it('names an icon for every agent role in the docs roles table, and none for the person', () => {
    const roles = readFileSync(join(import.meta.dir, '../../../../content/docs-tree/1.2.5-roles.md'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Role') && !line.startsWith('| ---'))
      .map((line) => line.split('|')[1]!.trim())
      .filter((cell) => !cell.includes('→') && cell !== 'Hand-off')
    expect(roles).toContain('Security Reviewer')
    for (const role of roles) {
      if (role === 'Principal') expect(iconForName(role)).toBeUndefined()
      else expect(iconForName(role)).toBeDefined()
    }
  })
})
