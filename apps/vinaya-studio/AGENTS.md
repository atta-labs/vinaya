# Vinaya Studio — agent instructions

## What Studio is

Studio's own specs say what it is and does, and every change here keeps them true:

- [`specs/studio.md`](specs/studio.md) — the app: its screens, its stack, that it runs only on the user's machine and reads only the Log.
- [`specs/mission-control.md`](specs/mission-control.md) — Mission Control: its states, the silence rules, the glyphs and icons, the row, the feed, the drawer, the task page, and how events reach the page.

## UI rules

Every UI change in this app follows three rule files at the repository root. Read all three before writing or editing any component, page, style or icon here:

- [`.claude/rules/ui-components.md`](../../.claude/rules/ui-components.md) — components live in the shared library, `@vinaya/ui` under [`packages/ui`](../../packages/ui), built on Ariakit primitives under shadcn's names and props, animated with `motion`; app code never renders raw interactive HTML; a missing component is added to the library.
- [`.claude/rules/ui-theme-tokens.md`](../../.claude/rules/ui-theme-tokens.md) — colours, radii and fonts only from the CSS variables the CMS theme renders; no palette classes or colour literals; inline styles only for runtime values; the four places icons come from.
- [`.claude/rules/ui-cms-theme.md`](../../.claude/rules/ui-cms-theme.md) — how the CMS theme reaches those variables, and why theme work never adds one.

To add a component to the library, follow the `ui-new-component` skill, [`.agents/skills/ui-new-component/SKILL.md`](../../.agents/skills/ui-new-component/SKILL.md).

These are the same files Claude Code loads on its own for any file under `apps/vinaya-*`, `packages/ui` or `packages/cms`, so Claude Code and Codex follow one text.

The component library is not in this app: every component, the shared layout and typography pieces, the class helper, the colour-scheme and theme helpers, the web shell the root layout renders through and the global stylesheet live in the shared UI package, `@vinaya/ui` under [`packages/ui`](../../packages/ui). This app keeps only its own chrome — the header with its three screens (`src/ui/header`) — and its stylesheet, `src/ui/styles/studio.css`, which imports the package's `@vinaya/ui/styles/globals.css` and is the one stylesheet the root layout imports.

The Sanity client, the product, branding and theme queries and the theme's renderer are not in this app: they live in the shared CMS package, `@vinaya/cms` under [`packages/cms`](../../packages/cms). Studio's one CMS read is `getStudioCms()` in `src/lib/studio-cms.ts`, under the `vinayaStudio` product key; the root layout is dynamic, so the theme is read on every request, and when the CMS cannot be reached the page renders unthemed, with no fallback values.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
