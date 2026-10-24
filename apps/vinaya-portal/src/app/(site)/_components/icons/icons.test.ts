import { describe, expect, it } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ELEMENT_ICONS, iconForHref } from './registry'

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

  it('shows only the first feature sign in each cell when still', () => {
    const groups = [...svg('features').querySelectorAll('[opacity]')]
    expect(groups.filter((group) => group.getAttribute('opacity') === '1')).toHaveLength(3)
    expect(groups.filter((group) => group.getAttribute('opacity') === '0')).toHaveLength(12)
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
})
