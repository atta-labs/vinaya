# @vinaya/cms — agent instructions

This package holds the Sanity client, the queries and the theme's renderer every Vinaya web app reads. Every change here follows the three UI rule files at the repository root; read them before editing the renderer, its field map or anything that writes a declaration:

- [`.claude/rules/ui-cms-theme.md`](../../.claude/rules/ui-cms-theme.md) — how the CMS theme reaches the variables, and why theme work never adds one.
- [`.claude/rules/ui-theme-tokens.md`](../../.claude/rules/ui-theme-tokens.md) — the variables the theme renders, and who may declare one.
- [`.claude/rules/ui-components.md`](../../.claude/rules/ui-components.md) — the component library in `@vinaya/ui`, which renders what this package reads.

These are the same files Claude Code loads on its own for any file under `apps/vinaya-*`, `packages/ui` or `packages/cms`, so Claude Code and Codex follow one text.
