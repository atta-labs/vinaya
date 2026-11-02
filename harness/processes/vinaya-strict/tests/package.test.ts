import { expect, test } from 'bun:test'
import manifest from '../package.json'

test('the Vinaya process package is private and named for its scope', () => {
  expect(manifest.name).toBe('@attalabs/process-vinaya')
  expect(manifest.private).toBe(true)
})
