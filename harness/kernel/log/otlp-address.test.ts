import { expect, test } from 'bun:test'
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
