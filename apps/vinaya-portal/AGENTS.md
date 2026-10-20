# Vinaya portal — agent instructions

## UI rules

Every UI change in this app follows three rule files at the repository root. Read all three before writing or editing any component, page, style or icon here:

- [`.claude/rules/ui-components.md`](../../.claude/rules/ui-components.md) — components live in `src/ui`, built on Ariakit primitives under shadcn's names and props, animated with `motion`; app code never renders raw interactive HTML; a missing component is added to the library.
- [`.claude/rules/ui-theme-tokens.md`](../../.claude/rules/ui-theme-tokens.md) — colours, radii and fonts only from the CSS variables the CMS theme renders; no palette classes or colour literals; inline styles only for runtime values; the four places icons come from.
- [`.claude/rules/ui-cms-theme.md`](../../.claude/rules/ui-cms-theme.md) — how the CMS theme reaches those variables, and why theme work never adds one.

To add a component to the library, follow the `ui-new-component` skill, [`.agents/skills/ui-new-component/SKILL.md`](../../.agents/skills/ui-new-component/SKILL.md).

These are the same files Claude Code loads on its own for any file under `apps/vinaya-*`, so Claude Code and Codex follow one text.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
