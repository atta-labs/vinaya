import { describe, expect, test } from 'bun:test'
import { checkDocumentationReadable } from '@attalabs/aeg-core'
import { type DocumentationResponse, probeDocumentationUrl } from '../../src/lib/forge-write'

const URL_ = 'https://docs.example.com/page'

function reply(code: number, headers: Record<string, string> = {}, location = ''): DocumentationResponse {
  return { code, location, headers: new Map(Object.entries(headers)) }
}

describe('probeDocumentationUrl classification', () => {
  const cases: [string, DocumentationResponse, unknown][] = [
    [
      '403 with x-ratelimit-remaining: 0',
      reply(403, { 'x-ratelimit-remaining': '0' }),
      { kind: 'unknown', reason: 'rate-limited' }
    ],
    ['429', reply(429), { kind: 'unknown', reason: 'rate-limited' }],
    ['retry-after on a 503', reply(503, { 'retry-after': '30' }), { kind: 'unknown', reason: 'rate-limited' }],
    ['plain 403', reply(403), { kind: 'unreadable', detail: 'status 403' }],
    [
      '403 with remaining > 0',
      reply(403, { 'x-ratelimit-remaining': '12' }),
      { kind: 'unreadable', detail: 'status 403' }
    ],
    ['404', reply(404), { kind: 'unreadable', detail: 'status 404' }],
    ['200', reply(200), { kind: 'readable' }]
  ]
  test.each(cases)('%s', (_name, response, expected) => {
    expect(probeDocumentationUrl(URL_, () => response)).toEqual(expected as never)
  })

  test('no response is unknown without a rate-limit reason', () => {
    expect(probeDocumentationUrl(URL_, () => undefined)).toEqual({ kind: 'unknown' })
  })

  test('redirect rules are unchanged', () => {
    expect(probeDocumentationUrl(URL_, () => reply(302, {}, 'https://other.example.com/x'))).toEqual({
      kind: 'unreadable',
      detail: 'redirects to another host, other.example.com'
    })
    expect(probeDocumentationUrl(URL_, () => reply(302, {}, 'https://docs.example.com/login'))).toEqual({
      kind: 'unreadable',
      detail: 'redirects to a sign-in page'
    })
  })
})

describe('rate-limit warning wording', () => {
  const body = `## Documentation\n\n- ${URL_} — the page\n`
  test('names the rate limit and the re-check, distinct from the timeout wording', () => {
    const limited = checkDocumentationReadable(body, () => ({ kind: 'unknown', reason: 'rate-limited' }), undefined)
    expect(limited.status).toBe('pass')
    expect(limited.warnings.join('\n')).toContain('rate limit')
    expect(limited.warnings.join('\n')).toContain('re-checked on the next gate run')
    const timeout = checkDocumentationReadable(body, () => ({ kind: 'unknown' }), undefined)
    expect(timeout.warnings.join('\n')).toContain('could not be reached in time')
  })
})
