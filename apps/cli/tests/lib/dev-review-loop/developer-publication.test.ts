/**
 * agent-confinement-v1 — unit tests for the pure gate logic the driver's
 * publishing tools run: commit-header validation (O2) and the pre-publication
 * checks (O7). The orchestration itself (the tool context's commit → push →
 * open, the reask loop) is covered through the in-process loop harness in
 * `inproc-5.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import {
  checkPublicationPreconditions,
  validateCommitHeader
} from '../../../src/lib/dev-review-loop/developer-publication.js'

describe('validateCommitHeader (O2)', () => {
  it('accepts a conforming Type(scope): Description header', () => {
    const r = validateCommitHeader('Feat(cli): add the publication step')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.header).toBe('Feat(cli): add the publication step')
  })

  it('accepts a scope-less Type: Description header', () => {
    expect(validateCommitHeader('Fix: correct the gate').ok).toBe(true)
  })

  it('trims a trailing newline and still accepts', () => {
    const r = validateCommitHeader('Docs: update the loop spec\n')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.header).toBe('Docs: update the loop spec')
  })

  it('rejects a missing header (null)', () => {
    const r = validateCommitHeader(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no commit header/)
  })

  it('rejects an empty header file', () => {
    const r = validateCommitHeader('   \n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/empty/)
  })

  it('rejects a multi-line body', () => {
    const r = validateCommitHeader('Feat(cli): add the step\n\nA longer body paragraph.')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/more than one non-empty line/)
  })

  it('rejects a non-conforming first line', () => {
    const r = validateCommitHeader('added the thing')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/does not match `Type\(scope\): Description`/)
  })

  it('rejects a header longer than 72 characters', () => {
    const header = `Feat(cli): ${'x'.repeat(70)}`
    expect(header.length).toBeGreaterThan(72)
    const r = validateCommitHeader(header)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/72/)
  })

  it('accepts a header exactly 72 characters long', () => {
    const header = `Feat(cli): ${'x'.repeat(61)}`
    expect(header.length).toBe(72)
    expect(validateCommitHeader(header).ok).toBe(true)
  })
})

describe('checkPublicationPreconditions (O7)', () => {
  const ok = {
    worktreeBranch: 'task/t/1',
    expectedBranch: 'task/t/1',
    worktreeHead: 'a'.repeat(40),
    recordedHead: 'a'.repeat(40),
    base: 'b'.repeat(40),
    expectedBase: 'b'.repeat(40),
    changedPaths: ['apps/cli/src/lib/x.ts'],
    surface: { in: ['apps/cli'], out: ['packages'] }
  }

  it('passes when branch, base, head and Surface all hold', () => {
    expect(checkPublicationPreconditions(ok).ok).toBe(true)
  })

  it('fails when the worktree is on the wrong branch', () => {
    const r = checkPublicationPreconditions({ ...ok, worktreeBranch: 'task/t/2' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not the task branch/)
  })

  it('fails when the worktree branch is unreadable', () => {
    const r = checkPublicationPreconditions({ ...ok, worktreeBranch: null })
    expect(r.ok).toBe(false)
  })

  it('fails when the base is not the expected base', () => {
    const r = checkPublicationPreconditions({ ...ok, base: 'c'.repeat(40) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not the expected base/)
  })

  it('fails when the head moved during the turn (the Developer committed)', () => {
    const r = checkPublicationPreconditions({ ...ok, worktreeHead: 'z'.repeat(40) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/do not commit yourself/)
  })

  it('fails when a changed path crosses an out: glob', () => {
    const r = checkPublicationPreconditions({ ...ok, changedPaths: ['packages/aeg-core/src/x.ts'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/out:/)
  })

  it('fails when a changed path matches no in: glob', () => {
    const r = checkPublicationPreconditions({ ...ok, changedPaths: ['apps/log-server/x.ts'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no `in:` glob/)
  })

  it('is inactive for base/head/Surface when their inputs are null', () => {
    expect(
      checkPublicationPreconditions({
        worktreeBranch: 'task/t/1',
        expectedBranch: 'task/t/1',
        worktreeHead: 'a'.repeat(40),
        recordedHead: null,
        base: 'b'.repeat(40),
        expectedBase: null,
        changedPaths: ['anything/at/all.ts'],
        surface: null
      }).ok
    ).toBe(true)
  })
})
