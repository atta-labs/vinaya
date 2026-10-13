import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mirrorPath = join(import.meta.dir, '../../specs/dev-review-evaluation-program.md')
const manifestPath = join(import.meta.dir, '../../specs/dev-review-evaluation-program.provenance.json')

type Manifest = {
  sourceUrl: string
  sourceDocumentId: string
  revision: number
  chunks: { commentId: number; bytes: number; sha256: string }[]
  totalBytes: number
  sha256: string
  documents: Record<string, { path: string; revisionPinned: boolean } | null>
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
const mirror = readFileSync(mirrorPath)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('developer-review evaluation program mirror', () => {
  it('pins the source identity and revision', () => {
    expect(manifest.sourceUrl).toBe(
      'https://linear.app/attalabs/document/tech-spec-developer-review-evaluation-program-768283062392'
    )
    expect(manifest.sourceDocumentId).toBe('535a4392-b658-4c92-835a-4b8f2d2830d4')
    expect(manifest.revision).toBe(14)
  })

  it('accounts for every named source document', () => {
    expect(manifest.documents).toEqual({
      'Tech spec — Developer-review on Atta Engine': {
        path: 'apps/cli/specs/dev-review-engine-state-machine.md',
        revisionPinned: false
      },
      'Tech spec — Developer-review capabilities and contracts': {
        path: 'apps/cli/specs/dev-review-capabilities-contracts.md',
        revisionPinned: false
      },
      'Tech spec — Agent sandbox': {
        path: 'apps/cli/specs/isolation.md',
        revisionPinned: false
      },
      'Any Process, One Harness': null
    })
  })

  it('matches the manifest byte count and complete digest', () => {
    expect(mirror.byteLength).toBe(manifest.totalBytes)
    expect(sha256(mirror)).toBe(manifest.sha256)
  })

  it('accounts for every byte through the ordered source chunks', () => {
    expect(manifest.chunks.map(({ commentId }) => commentId)).toEqual([6128511645, 6128511984])
    expect(manifest.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)).toBe(manifest.totalBytes)

    let offset = 0
    for (const chunk of manifest.chunks) {
      const bytes = mirror.subarray(offset, offset + chunk.bytes)
      expect(bytes.byteLength).toBe(chunk.bytes)
      expect(sha256(bytes)).toBe(chunk.sha256)
      offset += chunk.bytes
    }
    expect(offset).toBe(mirror.byteLength)
  })
})
