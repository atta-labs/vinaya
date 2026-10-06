import { describe, expect, it } from 'bun:test'
import {
  DOCUMENTATION_READ_MIN_SIZE,
  type FetchedDocument,
  visibleTextSize,
  whyNotCountedAsRead
} from '../../../src/lib/task-tools/fetch-documentation.js'

const SHELL_HTML = `<!doctype html><html><head><title>Linear</title>
<style>body { margin: 0 } ${'.x{color:red}'.repeat(100)}</style>
<script>window.__DATA__ = "${'a'.repeat(30_000)}";</script></head>
<body><div id="root">Loading…</div><script src="/app.js"></script></body></html>`

const DOC_HTML = `<html><head><title>Guide</title><script>var x = 1</script></head><body><h1>Guide</h1>${'<p>Real documentation sentence about one topic.</p>'.repeat(40)}</body></html>`

function page(body: string, contentType: string): FetchedDocument {
  return {
    requestedUrl: 'https://docs.example.com/page',
    finalUrl: 'https://docs.example.com/page',
    finalAddress: '93.184.216.34',
    framed: true,
    status: 200,
    contentType,
    body: new TextEncoder().encode(body)
  }
}

describe('visibleTextSize', () => {
  it('ignores script and style contents, tags and repeated whitespace', () => {
    expect(visibleTextSize('<style>a{}</style><p>Hi   <b>there</b></p><script>alert(1)</script>')).toBe(
      'Hi there'.length
    )
  })

  it('measures the shell fixture as its few visible characters', () => {
    expect(visibleTextSize(SHELL_HTML)).toBe('Linear Loading…'.length)
  })
})

describe('whyNotCountedAsRead for HTML', () => {
  it('refuses a large script-heavy shell and names the visible-text size', () => {
    expect(new TextEncoder().encode(SHELL_HTML).length).toBeGreaterThan(DOCUMENTATION_READ_MIN_SIZE)
    const why = whyNotCountedAsRead(page(SHELL_HTML, 'text/html; charset=utf-8'))
    expect(why).toContain('visible text is only 15 characters')
  })

  it('counts a real documentation page', () => {
    expect(whyNotCountedAsRead(page(DOC_HTML, 'text/html'))).toBeNull()
  })

  it('keeps the raw-size rule for other text types', () => {
    expect(whyNotCountedAsRead(page('x'.repeat(DOCUMENTATION_READ_MIN_SIZE), 'text/plain'))).toBeNull()
    expect(whyNotCountedAsRead(page('short', 'text/plain'))).toContain('only 5 bytes')
  })
})
