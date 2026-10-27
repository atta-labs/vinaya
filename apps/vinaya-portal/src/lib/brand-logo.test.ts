import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { CMSBranding } from '@/cms'

mock.module('server-only', () => ({}))

const { getFaviconMarkup, getLogoMarkup } = await import('./brand-logo')

const originalFetch = globalThis.fetch

const LOGO_URL = 'https://cdn.sanity.io/files/o56nzgrr/production/abc.svg'
const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 0L10 10" fill="var(--foreground, currentColor)"></path></svg>'

function stubFetch(body: string, headers: Record<string, string>, status = 200) {
  return spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => new Response(body, { status, headers }), { preconnect: originalFetch.preconnect })
  )
}

const branding = (url: string): CMSBranding =>
  ({
    _id: 'branding-vinayaPortal',
    productId: 'vinayaPortal',
    productName: 'Vinaya',
    logoSolidDark: { _type: 'file', url }
  }) as CMSBranding

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('getLogoMarkup — which URLs are ever fetched', () => {
  it.each([
    ['http, not https', 'http://cdn.sanity.io/files/p/d/a.svg'],
    ['a look-alike host', 'https://cdn.sanity.io.evil.example/files/p/d/a.svg'],
    ['userinfo pointing elsewhere', 'https://cdn.sanity.io@evil.example/files/p/d/a.svg'],
    ['a non-default port', 'https://cdn.sanity.io:8080/files/p/d/a.svg'],
    ['a file that is not an SVG', 'https://cdn.sanity.io/files/p/d/a.png'],
    ['an internal address', 'http://169.254.169.254/latest/meta-data']
  ])('refuses %s without fetching', async (_label, url) => {
    const fetchMock = stubFetch(LOGO, { 'content-type': 'image/svg+xml' })
    expect(await getLogoMarkup(branding(url))).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads nothing when the branding has no logo', async () => {
    const fetchMock = stubFetch(LOGO, { 'content-type': 'image/svg+xml' })
    expect(await getLogoMarkup(null)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getLogoMarkup — what a fetched logo must be', () => {
  it('returns the sanitized SVG, theme variables intact', async () => {
    stubFetch(LOGO, { 'content-type': 'image/svg+xml' })
    const markup = await getLogoMarkup(branding(LOGO_URL))
    expect(markup).toContain('<svg')
    expect(markup).toContain('var(--foreground, currentColor)')
  })

  it('strips script and event handlers before the markup is inlined', async () => {
    stubFetch(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="1" height="1"></rect></svg>',
      { 'content-type': 'image/svg+xml' }
    )
    const markup = await getLogoMarkup(branding(LOGO_URL))
    expect(markup).not.toContain('script')
    expect(markup).not.toContain('onload')
  })

  it('refuses a response that is not SVG', async () => {
    stubFetch(LOGO, { 'content-type': 'text/html' })
    expect(await getLogoMarkup(branding(LOGO_URL))).toBeNull()
  })

  it('refuses a failed response', async () => {
    stubFetch(LOGO, { 'content-type': 'image/svg+xml' }, 500)
    expect(await getLogoMarkup(branding(LOGO_URL))).toBeNull()
  })

  it('refuses a body over the size cap', async () => {
    stubFetch(`<svg xmlns="http://www.w3.org/2000/svg">${'<rect></rect>'.repeat(30000)}</svg>`, {
      'content-type': 'image/svg+xml'
    })
    expect(await getLogoMarkup(branding(LOGO_URL))).toBeNull()
  })
})

describe('getFaviconMarkup', () => {
  it('reads the branding favicon, not the logo', async () => {
    const fetchMock = stubFetch(LOGO, { 'content-type': 'image/svg+xml' })
    const favicon = {
      ...branding('https://cdn.sanity.io/files/p/d/logo.svg'),
      logoFavicon: { _type: 'file', url: 'https://cdn.sanity.io/files/p/d/favicon.svg' }
    } as CMSBranding
    expect(await getFaviconMarkup(favicon)).toContain('<svg')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cdn.sanity.io/files/p/d/favicon.svg')
  })
})
