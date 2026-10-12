// The failure taxonomy rests on a frozen bundle of forge comments: the bundle's
// bytes are pinned by its manifest, every failure task cites records that exist
// in it, and every registered defect is either seeded into a category or carries
// the reason the bundle does not show it.
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(import.meta.dir, 'failure-taxonomy')
const REGISTER_PATH = join(import.meta.dir, '..', 'fixtures', 'dev-review-architecture-invariants.json')

type Manifest = {
  source: { repository: string; dataIssue: number }
  exportWindow: { from: string; to: string; scope: string }
  selectionRule: string
  recordFields: string[]
  pullRequests: number
  records: number
  chunks: { commentId: number; bytes: number; sha256: string }[]
  totalBytes: number
  sha256: string
}

type BundleRecord = {
  pr: number
  title: string
  issues: number[]
  state: string
  mergedAt: string | null
  commentId: number
  createdAt: string
  author: string
  body: string
}

type Category = { id: string; definition: string }
type FailureTask = {
  id: string
  pr: number
  issue: number
  commentIds: number[]
  firstFailure: string
  category: string
}
type Seed = { defect: string; category?: string; notObserved?: string }
type Taxonomy = { bundle: string; categories: Category[]; tasks: FailureTask[]; registerSeed: Seed[] }

const manifest = JSON.parse(readFileSync(join(DIR, 'bundle-manifest.json'), 'utf8')) as Manifest
const bundle = readFileSync(join(DIR, 'bundle.jsonl'))
const taxonomy = JSON.parse(readFileSync(join(DIR, 'taxonomy.json'), 'utf8')) as Taxonomy
const register = JSON.parse(readFileSync(REGISTER_PATH, 'utf8')) as { defects: { id: string }[] }
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const records: BundleRecord[] = bundle
  .toString('utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as BundleRecord)
const recordById = new Map(records.map((record) => [record.commentId, record]))

describe('frozen historical-input bundle', () => {
  it('matches the manifest byte count and complete digest', () => {
    expect(bundle.byteLength).toBe(manifest.totalBytes)
    expect(sha256(bundle)).toBe(manifest.sha256)
  })

  it('accounts for every byte through the ordered source chunks', () => {
    expect(manifest.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)).toBe(manifest.totalBytes)

    let offset = 0
    for (const chunk of manifest.chunks) {
      const bytes = bundle.subarray(offset, offset + chunk.bytes)
      expect(bytes.byteLength).toBe(chunk.bytes)
      expect(sha256(bytes)).toBe(chunk.sha256)
      offset += chunk.bytes
    }
    expect(offset).toBe(bundle.byteLength)
  })

  it('pins its provenance: the data Issue, the export window and the selection rule', () => {
    expect(manifest.source).toEqual({ repository: 'atta-labs/vinaya', dataIssue: 1297 })
    expect(manifest.exportWindow.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(manifest.exportWindow.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(manifest.selectionRule.trim()).not.toBe('')
  })

  it('holds one record per forge comment, with the manifest fields', () => {
    expect(records.length).toBe(manifest.records)
    expect(recordById.size).toBe(records.length)
    expect(new Set(records.map(({ pr }) => pr)).size).toBe(manifest.pullRequests)
    // The window selects pull requests by creation date, so no comment on them
    // predates its start, and none postdates the export at its end.
    const end = `${manifest.exportWindow.to}T23:59:59Z`
    for (const record of records) {
      expect(Object.keys(record)).toEqual(manifest.recordFields)
      expect(record.createdAt >= manifest.exportWindow.from).toBe(true)
      expect(record.createdAt <= end).toBe(true)
    }
  })
})

describe('failure taxonomy', () => {
  const categoryIds = taxonomy.categories.map(({ id }) => id)

  it('names the bundle it is built from', () => {
    expect(taxonomy.bundle).toBe('apps/cli/tests/eval/failure-taxonomy/bundle.jsonl')
  })

  it('holds between 20 and 50 failure tasks with unique ids', () => {
    expect(taxonomy.tasks.length).toBeGreaterThanOrEqual(20)
    expect(taxonomy.tasks.length).toBeLessThanOrEqual(50)
    expect(new Set(taxonomy.tasks.map(({ id }) => id)).size).toBe(taxonomy.tasks.length)
  })

  it('rests every task on bundle records of its own pull request and Issue', () => {
    for (const task of taxonomy.tasks) {
      expect(task.firstFailure.trim()).not.toBe('')
      expect(task.commentIds.length).toBeGreaterThan(0)
      for (const commentId of task.commentIds) {
        const record = recordById.get(commentId)
        expect(record, `${task.id} cites ${commentId}`).toBeDefined()
        expect(record?.pr, `${task.id} cites ${commentId}`).toBe(task.pr)
        expect(record?.issues, `${task.id} names Issue ${task.issue}`).toContain(task.issue)
      }
    }
  })

  it('gives every category a definition and at least one task, and every task one known category', () => {
    expect(new Set(categoryIds).size).toBe(categoryIds.length)
    for (const category of taxonomy.categories) {
      expect(category.definition.trim()).not.toBe('')
      expect(
        taxonomy.tasks.some((task) => task.category === category.id),
        category.id
      ).toBe(true)
    }
    for (const task of taxonomy.tasks) expect(categoryIds, task.id).toContain(task.category)
  })
})

describe('defect-register seed', () => {
  const registerIds = register.defects.map(({ id }) => id)
  const categoryIds = new Set(taxonomy.categories.map(({ id }) => id))

  it('accounts for every registered defect exactly once', () => {
    expect(taxonomy.registerSeed.map(({ defect }) => defect).sort()).toEqual([...registerIds].sort())
  })

  it('names only defects the register holds', () => {
    for (const { defect } of taxonomy.registerSeed) expect(registerIds).toContain(defect)
  })

  it('maps each defect to a known category or states why the bundle does not show it', () => {
    for (const seed of taxonomy.registerSeed) {
      const mapped = seed.category !== undefined
      const unobserved = seed.notObserved !== undefined
      expect(mapped !== unobserved, seed.defect).toBe(true)
      if (mapped) expect(categoryIds.has(seed.category as string), seed.defect).toBe(true)
      else expect((seed.notObserved as string).trim(), seed.defect).not.toBe('')
    }
  })
})
