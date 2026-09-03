import { describe, expect, it } from 'vitest'
import { checkDoctrineNoProcedures } from './doctrine-no-procedures'

describe('checkDoctrineNoProcedures', () => {
  it('fails on a fenced block with two or more command-word lines', () => {
    const content = `# Some doctrine page

\`\`\`
git status
bun run test
\`\`\`
`
    const findings = checkDoctrineNoProcedures([{ path: 'aeg-root/roles/developer.md', content }])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('vinaya')
  })

  it('passes the same block inside the AEG:VENDOR-EXAMPLE anchor pair', () => {
    const content = `# tranche-model

<!-- AEG:VENDOR-EXAMPLE:START -->
\`\`\`
git status
bun run test
\`\`\`
<!-- AEG:VENDOR-EXAMPLE:END -->
`
    const findings = checkDoctrineNoProcedures([{ path: 'aeg-root/tranche-model.md', content }])
    expect(findings).toHaveLength(0)
  })

  it('passes a file under a templates/ directory', () => {
    const content = `\`\`\`
git status
bun run test
\`\`\`
`
    const findings = checkDoctrineNoProcedures([{ path: 'aeg-root/templates/pr-report-template.md', content }])
    expect(findings).toHaveLength(0)
  })

  it('passes a single-command block', () => {
    const content = `\`\`\`
git status
\`\`\`
`
    const findings = checkDoctrineNoProcedures([{ path: 'aeg-root/roles/developer.md', content }])
    expect(findings).toHaveLength(0)
  })
})
