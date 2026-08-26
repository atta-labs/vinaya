import { describe, expect, it } from 'vitest'
import { checkDoctrinePortability, NON_PATH_TOP_SEGMENTS } from './doctrine-portability'

function file(path: string, content: string) {
  return { path, content }
}

describe('checkDoctrinePortability', () => {
  it('is silent on a file outside shipsPrefix, however non-portable its citations look', () => {
    const findings = checkDoctrinePortability([file('README.md', 'See `packages/aeg-core/src/foo.ts`.')])
    expect(findings).toEqual([])
  })

  it('flags a citation whose top segment is author-repo internal', () => {
    const findings = checkDoctrinePortability([
      file('aeg-root/enforcement.md', 'Run `packages/aeg-core/bin/verify-docs.ts` before opening.')
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      file: 'aeg-root/enforcement.md',
      line: 1,
      cited: 'packages/aeg-core/bin/verify-docs.ts'
    })
  })

  it('is silent on a doctrine-relative citation (roles/contracts/skills/aeg-root)', () => {
    const findings = checkDoctrinePortability([
      file(
        'aeg-root/enforcement.md',
        'See `roles/developer.md`, `contracts/brief-developer.md`, `skills/brief-authoring/SKILL.md`, and `aeg-root/glossary.md`.'
      )
    ])
    expect(findings).toEqual([])
  })

  it('is silent on an adopter-owned citation (.github/.vinaya/.claude)', () => {
    const findings = checkDoctrinePortability([
      file(
        'aeg-root/enforcement.md',
        'Reads `.github/workflows/ci.yml`, `.vinaya/doc-owners`, and `.claude/settings.json`.'
      )
    ])
    expect(findings).toEqual([])
  })

  it('exempts the three illustrative placeholders by literal', () => {
    const findings = checkDoctrinePortability([
      file(
        'aeg-root/templates/brief-template.md',
        '- [path/inside/the/shipped/diff.ts] contains: [x]\n' +
          '- [path/inside/the/surface.ts] contains: [y]\n' +
          'See `apps/x/specs/...` for the shape.'
      )
    ])
    expect(findings).toEqual([])
  })

  it('does not treat apps/cli/dist/index.js (build output) as different from apps/cli/src/index.ts (source)', () => {
    const findings = checkDoctrinePortability([
      file('aeg-root/enforcement.md', 'Entry point is `apps/cli/dist/index.js`, built from `apps/cli/src/index.ts`.')
    ])
    expect(findings).toHaveLength(2)
    expect(findings.map((f) => f.cited)).toEqual(['apps/cli/dist/index.js', 'apps/cli/src/index.ts'])
  })

  it('flags a bare bin/ or src/ citation as author-repo internal', () => {
    const findings = checkDoctrinePortability([
      file('aeg-root/enforcement.md', 'See `bin/open-pr.ts` and `src/baseline-capture.ts`.')
    ])
    expect(findings).toHaveLength(2)
  })

  it('flags an unclassified top-level prefix rather than passing it — no deny-list means no free pass', () => {
    const findings = checkDoctrinePortability([file('aeg-root/enforcement.md', 'Fires `tools/whatever.ts` on push.')])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.cited).toBe('tools/whatever.ts')
  })

  it('does not treat a leading-slash web route as a cited repo path', () => {
    const findings = checkDoctrinePortability([
      file('aeg-root/tranche-model.md', 'Rendered live at `/docs/state-machine`, not a repo path at all.')
    ])
    expect(findings).toEqual([])
  })

  it('reports the correct line number for a citation past the first line', () => {
    const findings = checkDoctrinePortability([
      file('aeg-root/enforcement.md', 'line one\nline two\nsee `packages/x/y.ts` here')
    ])
    expect(findings[0]?.line).toBe(3)
  })
})

describe('the gate can see what it flags — non-vacuity self-test', () => {
  const NON_PORTABLE_SAMPLES: Record<string, string> = {
    'packages/…': 'packages/aeg-core/bin/verify-docs.ts',
    'apps/…': 'apps/cli/dist/index.js',
    'bare bin/': 'bin/open-pr.ts',
    'bare src/': 'src/baseline-capture.ts',
    'an unclassified prefix': 'tools/whatever.ts'
  }

  for (const [label, cited] of Object.entries(NON_PORTABLE_SAMPLES)) {
    it(`fires on a real instance of ${label}`, () => {
      const findings = checkDoctrinePortability([file('aeg-root/sample.md', `See \`${cited}\`.`)])
      expect(findings, `pattern never fires on its own sample: ${cited}`).toHaveLength(1)
    })
  }

  const PORTABLE_SAMPLES = [
    'roles/developer.md',
    'contracts/brief-developer.md',
    'skills/brief-authoring/SKILL.md',
    'aeg-root/glossary.md',
    '.github/workflows/ci.yml',
    '.vinaya/doc-owners',
    '.claude/settings.json'
  ]

  for (const cited of PORTABLE_SAMPLES) {
    it(`stays silent on a real instance of ${cited}`, () => {
      const findings = checkDoctrinePortability([file('aeg-root/sample.md', `See \`${cited}\`.`)])
      expect(findings, `portable citation wrongly flagged: ${cited}`).toEqual([])
    })
  }
})

describe('a non-default shipsPrefix is portable too, not just the hardcoded default', () => {
  it('treats a self-citation under a custom shipsPrefix as portable', () => {
    const findings = checkDoctrinePortability(
      [file('my-docs/foo.md', 'See `my-docs/roles/bar.md` for the shape.')],
      'my-docs/'
    )
    expect(findings).toEqual([])
  })

  it('does NOT special-case the literal string "aeg-root/" once a different shipsPrefix is in play', () => {
    const findings = checkDoctrinePortability(
      [file('my-docs/foo.md', 'See `aeg-root/roles/bar.md` for the shape.')],
      'my-docs/'
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.cited).toBe('aeg-root/roles/bar.md')
  })

  it('still recognizes the static portable prefixes (roles/, .github/, …) under a custom shipsPrefix', () => {
    const findings = checkDoctrinePortability(
      [file('my-docs/foo.md', 'See `roles/bar.md` and `.github/workflows/ci.yml`.')],
      'my-docs/'
    )
    expect(findings).toEqual([])
  })
})

describe('NON_PATH_TOP_SEGMENTS is a closed, tested set — never silently grown', () => {
  it('carries exactly these five top segments, no more, no fewer', () => {
    expect([...NON_PATH_TOP_SEGMENTS].sort()).toEqual(['HEAD', 'fix', 'origin', 'refs', 'vinaya'])
  })

  const EXCLUDED_SAMPLES = ['origin/main', 'refs/pull/1/merge', 'HEAD/detached', 'vinaya/blocked', 'fix/some-branch']

  for (const cited of EXCLUDED_SAMPLES) {
    it(`excludes "${cited}" from citation consideration entirely (git-ref/label shape, not a path)`, () => {
      const findings = checkDoctrinePortability([file('aeg-root/sample.md', `See \`${cited}\`.`)])
      expect(findings).toEqual([])
    })
  }

  it('a top segment NOT on the excluded list is still a real, flaggable citation — the set never fails open beyond its own five entries', () => {
    const findings = checkDoctrinePortability([file('aeg-root/sample.md', 'See `notexcluded/whatever.ts`.')])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.cited).toBe('notexcluded/whatever.ts')
  })
})
