# 0011. Portal UI on Ariakit and CMS theme variables

**Status:** Accepted

**Date:** 2026-10-20

## Context

The portal came into this repository from the Atta Labs monorepo, where its UI ran on a shared package with three component libraries side by side. Each library vendored its upstream's files verbatim, installed through the shadcn command line, and a contract validator kept their exports in step. The portal's copy no longer carries that system: its own component library under `apps/vinaya-portal/src/ui` builds each component on an Ariakit primitive while keeping shadcn's component names and props, so call sites read as shadcn code, and animates with `motion`.

The portal's look comes from a theme document in the Atta Labs Sanity project. The CMS theme renders shadcn's variable set plus its own `success`, `warning`, their foregrounds, the hover colours, the shadow colour, the header background and the gradients. Any colour, radius or font that does not come from those variables escapes the theme: it is wrong in the other colour scheme and wrong under the next theme, and nothing in the CMS can correct it.

The rules for this lived in the Atta Labs repository as Claude Code skills, written for the three-library system. Two coding agents work on this repository, Claude Code and Codex, and both must follow the same rules from the same text. Claude Code loads path-scoped rule files from `.claude/rules` when it reads or edits a matching file. Codex reads `AGENTS.md` files, but a Codex dispatched from the repository root reads only the root `AGENTS.md`, which Vinaya generates and which no task may edit.

## Decision

We will build every UI component of the portal's web apps in the portal's own component library, on an Ariakit primitive, under shadcn's component names and props, animated with `motion`. App code uses those components and never raw interactive HTML elements; a missing component is added to the library, never hand-rolled in a page.

We will take colours, radii and fonts only from the CSS variables the portal's CMS theme renders, through Tailwind's semantic classes or `var()`. The CMS theme is the source of truth for that set. Only the theme's renderer and the `@theme` mappings of the global stylesheet declare CSS variables, and theme work never adds one. Icons come from `lucide-react`, the brand-icon component, the product-icon registry and the marks folder, and nowhere else.

We will state these rules once, in three rule files under `.claude/rules` scoped to `apps/vinaya-*/**`, with one skill for adding a component whose full text lives under `.agents/skills`. The portal's `AGENTS.md` points Codex at the same files, and its `CLAUDE.md` imports that `AGENTS.md`.

## Considered options

- Keep the Atta Labs multi-library system: vendored upstream files, the shadcn command-line install and a contract validator across libraries. This keeps the portal identical to its origin, but it carries machinery for libraries the portal does not use and ties every component to files that may never be edited.
- Use shadcn's own components, which are built on Radix. This keeps the upstream's code as well as its names, but it brings a second headless library beside the Ariakit components the portal already runs on, and two primitives for one behaviour.
- Build on Ariakit under shadcn's names and props, with the CMS theme's variables only. This is the chosen option. Call sites keep shadcn's familiar shape, behaviour comes from one headless library, and the theme reaches every colour, radius and font.
- Write the rules in the portal's `AGENTS.md` alone. Codex opened in the portal would read them, but a Codex dispatched from the repository root would not, and a second web app would need its own copy of the same text.
- Enforce the rules with an agent hook that refuses an edit. A hook reaches only the agent it is written for, and a human or another tool bypasses it; a check in CI reaches every writer.

## Consequences

Claude Code loads the rules on its own for any file under `apps/vinaya-*`, including a later app such as `apps/vinaya-studio`, with no edit to the glob. Codex opened in the portal reads the same files through the portal's `AGENTS.md`. A Codex dispatched from the repository root does not read them on its own, so every portal task Issue lists the three UI rule files under its `## Documentation`, which makes each rendered brief direct both agents to read them. A CI check, `atta-labs/ui-rules`, enforces the rules for every writer.

A component the portal needs and lacks costs a library change before the page change. A colour the theme does not render cannot be used until the shared theme schema gains a field, which is a decision outside UI work and affects every product bound to that theme. Code already in the portal that breaks a rule stays until a change touches it; the rules hold for new code from this decision on.

## Where it is applied

The rules are `.claude/rules/ui-components.md`, `.claude/rules/ui-theme-tokens.md` and `.claude/rules/ui-cms-theme.md`. The component workflow is the `ui-new-component` skill, `.agents/skills/ui-new-component/SKILL.md`, which `.claude/skills/ui-new-component/SKILL.md` loads for Claude Code. `apps/vinaya-portal/AGENTS.md` points Codex at the rules, and `apps/vinaya-portal/CLAUDE.md` imports it. The component library is `apps/vinaya-portal/src/ui`; the theme's renderer is `apps/vinaya-portal/src/cms/utils/theme.ts`, and its Tailwind mappings are the `@theme inline` block of `apps/vinaya-portal/src/ui/styles/globals.css`.
