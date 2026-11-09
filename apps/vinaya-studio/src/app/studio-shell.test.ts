import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CMSTheme, ProductCms, ProductKey } from '@vinaya/cms'

mock.module('server-only', () => ({}))
mock.module('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))

// The real CMS package, with only its network read replaced: the shell's renderer stays the real one.
const realCms = await import('@vinaya/cms')
const readKeys: ProductKey[] = []
let cmsResult: ProductCms = { config: null, branding: null }
mock.module('@vinaya/cms', () => ({
  ...realCms,
  getProductCms: async (product: ProductKey) => {
    readKeys.push(product)
    return cmsResult
  }
}))

const { NextWebShell } = await import('@vinaya/ui/server')
const layout = await import('./layout')
const { STUDIO_SCREENS, isOnScreen } = await import('@/ui/header/screens')
const { default: MissionControlPage } = await import('./page')
const { default: MilestonesPage } = await import('./milestones/page')
const { default: TasksPage } = await import('./tasks/page')

const theme = {
  light: { background: 'white', foreground: 'black', primary: 'navy' },
  dark: { background: 'black', foreground: 'white', primary: 'skyblue' }
} as unknown as CMSTheme

type ShellProps = Parameters<typeof NextWebShell>[0]

/** The layout's element, and the document the real shell renders from its props. */
async function renderLayout(): Promise<{ element: ReactElement<ShellProps>; html: string }> {
  const element = (await layout.default({ children: createElement('p', null, 'screen') })) as ReactElement<ShellProps>
  const document = await NextWebShell(element.props)
  return { element, html: renderToStaticMarkup(document) }
}

function childTypes(children: ReactNode): unknown[] {
  return (Array.isArray(children) ? children : [children]).filter(isValidElement).map((child) => child.type)
}

beforeEach(() => {
  readKeys.length = 0
})

describe('Studio root layout', () => {
  it('renders through the shared web shell with the theme read under the vinayaStudio key', async () => {
    cmsResult = {
      config: { _id: 'vinayaStudioConfig', userInterface: { theme, colorScheme: 'dark', library: null } },
      branding: null
    }
    const { element, html } = await renderLayout()
    expect(element.type).toBe(NextWebShell)
    expect(readKeys).toEqual(['vinayaStudio'])
    expect(element.props.config).toBe(cmsResult.config)
    expect(html).toContain('<style id="vinaya-studio-theme">')
    expect(html).toContain(realCms.generateThemeCSSForScheme(theme, 'dark'))
    expect(html).toContain('data-theme="dark"')
  })

  it('is rendered per request, so the theme is read at runtime', () => {
    expect(layout.dynamic).toBe('force-dynamic')
  })

  it('renders unthemed, with no theme style of any kind, when the CMS cannot be reached', async () => {
    cmsResult = { config: null, branding: null }
    const { element, html } = await renderLayout()
    expect(element.props.config).toBeNull()
    expect(html).not.toContain('<style')
    expect(html).not.toContain('--primary')
  })

  it("puts Studio's header above every screen", async () => {
    cmsResult = { config: null, branding: null }
    const { element } = await renderLayout()
    const { StudioHeader } = await import('@/ui/header')
    expect(childTypes(element.props.children)).toContain(StudioHeader)
  })
})

describe("Studio's screens", () => {
  it('has Milestones, Tasks and Mission Control in its navigation, with Mission Control at the root', () => {
    expect(STUDIO_SCREENS.map((screen) => [screen.label, screen.href])).toEqual([
      ['Milestones', '/milestones'],
      ['Tasks', '/tasks'],
      ['Mission Control', '/']
    ])
  })

  it('marks the screen the path is on, and the landing screen only at the root', () => {
    expect(isOnScreen('/', '/')).toBe(true)
    expect(isOnScreen('/tasks', '/')).toBe(false)
    expect(isOnScreen('/tasks', '/tasks')).toBe(true)
    expect(isOnScreen('/tasks/12', '/tasks')).toBe(true)
    expect(isOnScreen('/tasksx', '/tasks')).toBe(false)
    expect(isOnScreen(null, '/')).toBe(false)
  })

  it('says Milestones and Tasks are not built yet', () => {
    expect(renderToStaticMarkup(createElement(MilestonesPage))).toContain('Milestones is not built yet.')
    expect(renderToStaticMarkup(createElement(TasksPage))).toContain('Tasks is not built yet.')
  })

  it("lands on Mission Control's empty board frame", () => {
    const html = renderToStaticMarkup(createElement(MissionControlPage))
    expect(html).toContain('Mission Control')
    expect(html).toContain('data-board-field="repository"')
    expect(html).toContain('data-board-field="branch"')
    expect(html).toContain('data-board-part="counts"')
    expect(html).toContain('data-board-part="list"')
    expect(html).toContain('No tasks yet.')
  })
})
