import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveOtlpAddress } from './otlp-address.js'

const url = 'https://collector.example'
const anchor = 'https://default.example'
const settings = {
  localConfig: { logs: { otlp: { url } } },
  trustAnchorConfig: { logs: { otlp: { url: anchor, headers: { authorization: 'Bearer ${TOKEN}' } } } },
  env: {},
  unattended: false
}

test('interactive callers use working settings and unattended callers use the default branch', () => {
  expect(resolveOtlpAddress(settings)).toMatchObject({ kind: 'address', url })
  expect(resolveOtlpAddress({ ...settings, unattended: true, env: { TOKEN: 'value' } })).toEqual({
    kind: 'address',
    url: anchor,
    headers: { authorization: 'Bearer value' }
  })
  expect(resolveOtlpAddress({ ...settings, unattended: true, trustAnchorConfig: {} })).toEqual({
    kind: 'none',
    reason: 'default branch has no logs.otlp address'
  })
})

test('CI needs its credentials and a server address alone never resolves', () => {
  expect(resolveOtlpAddress({ ...settings, env: { GITHUB_ACTIONS: 'true', TOKEN: '' } })).toMatchObject({
    kind: 'none',
    reason: expect.stringContaining('credential')
  })
  expect(resolveOtlpAddress({ ...settings, localConfig: { logs: { url } } })).toMatchObject({ kind: 'none' })
})

test('an address whose credential variable is unset never resolves, so nothing is posted unauthenticated', () => {
  const withCredential = { logs: { otlp: { url, headers: { authorization: 'Bearer ${TOKEN}' } } } }
  for (const env of [{}, { TOKEN: '' }]) {
    expect(resolveOtlpAddress({ ...settings, localConfig: withCredential, env })).toEqual({
      kind: 'none',
      reason: 'the logs.otlp headers name a credential variable that is not set'
    })
  }
  expect(resolveOtlpAddress({ ...settings, localConfig: withCredential, env: { TOKEN: 'value' } })).toEqual({
    kind: 'address',
    url,
    headers: { authorization: 'Bearer value' }
  })
})

test("this repository's committed settings resolve the Log server's OpenTelemetry address, credential from VINAYA_LOG_TOKEN", () => {
  const committed = JSON.parse(readFileSync(join(import.meta.dir, '../../../vinaya.config.json'), 'utf8'))
  const eventsUrl: string = committed.logs.url
  // The address is the repository's routes with the events tail replaced by `otlp`; the sender adds `/v1/<signal>`.
  const expected = eventsUrl.replace(/\/events$/, '/otlp')
  expect(expected).not.toBe(eventsUrl)
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the settings syntax under test, never a JS template
  expect(committed.logs.otlp.headers).toEqual({ authorization: 'Bearer ${VINAYA_LOG_TOKEN}' })

  const env = { VINAYA_LOG_TOKEN: 'from-the-environment' }
  const address = { kind: 'address' as const, url: expected, headers: { authorization: 'Bearer from-the-environment' } }
  // Interactive: the working tree's settings. Unattended and on CI: the default branch's, which are these once merged.
  expect(resolveOtlpAddress({ localConfig: committed, trustAnchorConfig: null, unattended: false, env })).toEqual(
    address
  )
  expect(resolveOtlpAddress({ localConfig: null, trustAnchorConfig: committed, unattended: true, env })).toEqual(
    address
  )
  expect(
    resolveOtlpAddress({
      localConfig: null,
      trustAnchorConfig: committed,
      unattended: false,
      env: { ...env, CI: 'true' }
    })
  ).toEqual(address)
})
