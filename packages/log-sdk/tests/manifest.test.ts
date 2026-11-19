import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('publishes the Log SDK publicly from its Vinaya repository directory', () => {
  expect(manifest).not.toHaveProperty('private')
  expect(manifest.publishConfig.access).toBe('public')
  expect(manifest.repository).toEqual({
    type: 'git',
    url: 'git+https://github.com/atta-labs/vinaya.git',
    directory: 'packages/log-sdk'
  })
  expect(manifest.files).toEqual(['dist', 'src', 'README.md', 'LICENSE'])
})

test('uses built entry points for Node and keeps source exports for Bun', () => {
  expect(manifest.bin).toEqual({ 'vinaya-log': 'dist/bin/vinaya-log.js' })
  expect(manifest.types).toBe('./dist/index.d.ts')
  expect(manifest.exports['.']).toEqual({
    source: './src/index.ts',
    bun: './src/index.ts',
    types: './dist/index.d.ts',
    import: './dist/index.js',
    default: './dist/index.js'
  })
})
