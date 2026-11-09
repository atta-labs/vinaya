# @vinaya/ui — agent instructions

This package is the component library every Vinaya web app builds from, with its global stylesheet. Every change here follows the three UI rule files at the repository root. Read all three before writing or editing any component, helper or style here:

- [`.claude/rules/ui-components.md`](../../.claude/rules/ui-components.md) — what the library holds, built on Ariakit primitives under shadcn's names and props, animated with `motion`.
- [`.claude/rules/ui-theme-tokens.md`](../../.claude/rules/ui-theme-tokens.md) — colours, radii and fonts only from the CSS variables the CMS theme renders; who may declare a variable.
- [`.claude/rules/ui-cms-theme.md`](../../.claude/rules/ui-cms-theme.md) — how the CMS theme reaches those variables, and why theme work never adds one.

To add a component, follow the `ui-new-component` skill, [`.agents/skills/ui-new-component/SKILL.md`](../../.agents/skills/ui-new-component/SKILL.md).

These are the same files Claude Code loads on its own for any file under `apps/vinaya-*`, `packages/ui` or `packages/cms`, so Claude Code and Codex follow one text.
