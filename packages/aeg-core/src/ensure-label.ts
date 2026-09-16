/**
 * Idempotent label-minting — the
 * decision logic three call sites (`apps/cli/src/commands/audit.ts`,
 * `bin/check-direct-main-push.ts`, `bin/dead-branch-audit.ts`) each
 * reimplemented: does this label already exist on the forge, and if not,
 * create it. Pure — no `gh` shell-outs here; each call site injects its own
 * `listLabelNames`/`createLabel`, so this module stays agnostic to how a
 * caller shells out (array-arg `execFileSync` vs. string `execSync`) and to
 * whether a caller lets `gh` failures throw or swallows them — those are
 * call-site error-handling policies this extraction does not change.
 *
 * Mints lazily, on first use, by design — never called to bootstrap the
 * full label vocabulary (`@attalabs/aeg-forge-state`'s `labels.ts`) ahead of
 * need.
 */

export type LabelExistenceIo = {
  listLabelNames: (repoFlag: string) => string[]
  createLabel: (repoFlag: string, name: string, description: string, color: string) => void
}

export const LABEL_COLOR = 'B60205'

export function ensureLabelExists(repoFlag: string, name: string, description: string, io: LabelExistenceIo): void {
  const existing = io.listLabelNames(repoFlag)
  if (existing.includes(name)) return
  io.createLabel(repoFlag, name, description, LABEL_COLOR)
}
