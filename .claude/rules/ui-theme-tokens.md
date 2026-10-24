---
paths:
  - "apps/vinaya-*/**"
---

# Theme variables, colours, styles and icons — the portal's web apps

These rules govern every web app under `apps/vinaya-*`. They are one of three UI rule files, read together: `.claude/rules/ui-components.md` (components), this file (variables, colours, radii, fonts, inline styles, icons) and `.claude/rules/ui-cms-theme.md` (how the CMS theme reaches the variables). Claude Code loads them for any file under `apps/vinaya-*`; Codex is pointed at them by the app's `AGENTS.md`. The `atta-labs/ui-rules` check enforces them in CI on every pull request, whichever agent wrote the change.

## The rule

Colours, radii and fonts come only from the CSS variables the portal's CMS theme renders, listed below, reached through Tailwind's semantic classes or through `var()`. The CMS theme is the source of truth for that set: a variable it does not render does not exist. No UI code declares a variable of its own.

If the colour you want is not in the list, pick the listed variable whose role fits (the role tables below), or a shade of one through opacity (`bg-primary/10`, `color-mix(in oklch, var(--muted-foreground) 35%, transparent)`). Never reach for a palette class or a literal.

## The variables the CMS theme renders

`apps/vinaya-portal/src/cms/utils/theme.ts` turns a theme document into variables. A colour field's variable is its name in kebab case: a one-word field (`primary`) keeps its name, and a longer one is mapped by `FIELD_TO_CSS_VAR` in `apps/vinaya-portal/src/cms/types.ts` (`primaryForeground` becomes `--primary-foreground`). `colorFieldNames` in `apps/vinaya-portal/src/cms/utils/theme-corpus.fixture.json` is the set of colour fields every shipped theme document uses. Those are the variables below, and no others.

### Colours with a Tailwind class

Each of these has a `--color-*` line in the `@theme inline` block of `apps/vinaya-portal/src/ui/styles/globals.css`, so `bg-*`, `text-*`, `border-*`, `ring-*`, `fill-*`, `stroke-*` and the other colour utilities reach it.

| Variable | Tailwind name | Role |
| --- | --- | --- |
| `--background` / `--foreground` | `background` / `foreground` | The page canvas and its ink |
| `--card` / `--card-foreground` | `card` / `card-foreground` | A discrete content surface and its ink |
| `--popover` / `--popover-foreground` | `popover` / `popover-foreground` | A floating surface (popover, menu, dialog body) and its ink |
| `--primary` / `--primary-foreground` | `primary` / `primary-foreground` | The action, the selected item, emphasis; the ink on a primary fill |
| `--secondary` / `--secondary-foreground` | `secondary` / `secondary-foreground` | Persistent chrome (bars, strips) and its ink |
| `--muted` / `--muted-foreground` | `muted` / `muted-foreground` | A recessed fill; the quiet ink for metadata, captions, hints |
| `--accent` / `--accent-foreground` | `accent` / `accent-foreground` | The hover fill and the ink on it |
| `--destructive` / `--destructive-foreground` | `destructive` / `destructive-foreground` | Failure and irreversible actions; the ink on a destructive fill |
| `--success` | `success` | A positive outcome: passed, merged, complete |
| `--warning` | `warning` | Needs attention: partial, revised, near a limit |
| `--border` | `border` | Every default border and divider |
| `--input` | `input` | An editable field's surface and border |
| `--ring` | `ring` | The focus ring, and the site's accent detail in its drawn icons |
| `--chart-1` … `--chart-5` | `chart-1` … `chart-5` | Categorical series in one visualization |
| `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring` | `sidebar`, `sidebar-foreground`, … | The sidebar component only |

Pair a surface with its own ink: `bg-card` with `text-card-foreground`, `bg-primary` with `text-primary-foreground`. On the page canvas, the inks are `foreground` and `muted-foreground`. A status (`success`, `warning`, `destructive`) names an outcome, never a mood; as text it is `text-success`, as a soft fill `bg-success/10 text-success border-success/40`.

### Colours reached through `var()`

The CMS theme also renders these. They have no `@theme` mapping today, so code reads them through `var()` — in a stylesheet, in a Tailwind arbitrary value that names the variable (`bg-[var(--header-background)]`), or through the canvas helper below.

| Variable | Role |
| --- | --- |
| `--success-foreground`, `--warning-foreground` | The ink on a hard `success` or `warning` fill |
| `--primary-hover`, `--secondary-hover` | The hover fill of a `primary` or `secondary` filled control |
| `--shadow-color` | The colour of the theme's shadows, separate from `--border` |
| `--header-background` | The site header's background |
| `--gradient-primary`, `--gradient-background`, `--gradient-card` | The theme's gradients |

Adding a `--color-*` line to `@theme inline` for one of these is not adding a variable: it exposes a variable the CMS theme already renders as a Tailwind class.

### Fonts, radius, tracking, spacing and shadows

| Variable | How code reaches it |
| --- | --- |
| `--font-sans`, `--font-serif`, `--font-mono` | `font-sans` (body, controls, labels), `font-serif` (headings, display), `font-mono` (technical data, code); or `Text` / `Heading`'s `family` prop |
| `--radius` | `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-2xl`, `rounded-3xl`, `rounded-4xl`, each derived from `--radius` in `@theme inline` |
| `--tracking-normal` | Tailwind's `tracking-normal` |
| `--spacing` | Tailwind's spacing scale (`p-4`, `gap-2`, `size-9`), which multiplies it |
| `--shadow-2xs`, `--shadow-xs`, `--shadow-sm`, `--shadow`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--shadow-2xl` | The `shadow-*` utilities of the same names in `globals.css` |

A font is never named in code: no font family in a class (`font-['DM_Mono']`), a style or `next/font`. A radius is a `rounded-*` step, never a length (`rounded-[6px]`); `rounded-none` and `rounded-full` are shapes, not theme radii, and stay allowed.

## Who declares variables

Only two places declare CSS variables:

1. **The CMS theme's renderer.** `generateThemeCSS` and `generateThemeCSSForScheme` in `apps/vinaya-portal/src/cms/utils/theme.ts`, written into the page by `NextWebShell`, and the preview-theme helper (`applyThemeToDOM` in `apps/vinaya-portal/src/ui/lib/preview-theme-utils.ts`), which writes the same theme's variables at runtime. They render the theme; they do not invent variables.
2. **The `@theme inline` mappings of `apps/vinaya-portal/src/ui/styles/globals.css`**, which expose the rendered variables to Tailwind.

No other code declares one: no `--x:` in a stylesheet, no `:root` or `.dark` block of defaults, no `style={{ '--x': value }}`, no `element.style.setProperty('--x', …)` outside the preview helper.

## Forbidden

- **Palette classes.** `text-green-500`, `bg-zinc-900`, `border-amber-200/40`, `ring-blue-400` — any colour from Tailwind's default palette.
- **Absolute colours.** `text-white`, `bg-black`, `text-white/80`, `fill-black`. `transparent`, `currentColor` and `inherit` are not colours and stay allowed.
- **Colour literals.** Any hex (`#1a1610`), `oklch(…)`, `hsl(…)`/`hsla(…)` or `rgb(…)`/`rgba(…)` value, in a class (`bg-[#1a1610]`, `text-[oklch(65%_0.17_145)]`), in a style, in a stylesheet, in an SVG attribute or in a constant. The renderer's handling of the theme's own values (`src/cms/utils/oklch.ts`, `src/cms/utils/css-safety.ts`) and the theme corpus fixture are the theme itself, not UI code.
- **A colour of no listed variable.** `var(--brand-blue)` names nothing the theme renders.

## Inline styles

`style={{ … }}` is forbidden except for a value computed at runtime: a width from a measurement, a transform from a pointer position, a progress percentage. A constant, a spacing, a colour or a font is a Tailwind class. A runtime style that needs a theme colour names it through `var()` (`style={{ background: `color-mix(in oklch, var(--primary) ${pct}%, transparent)` }}`), never a literal; it sets the property itself and never declares a custom property.

## Canvas and three.js

A canvas or three.js scene takes a colour as a number, not a CSS value. It reads the theme through `tokenHex('--primary')` or `colorHex(…)` from `apps/vinaya-portal/src/ui/lib/theme-color.ts`, which resolves the live variable; it never holds a colour number of its own. `tokenHex` throws on a variable the theme did not render, by design.

## Icons

Icons come from four places, and only these:

| Icon | Source |
| --- | --- |
| Every other icon, including generic interface icons and a feature’s parts | [`lucide-react`](https://lucide.dev) |
| A third-party brand (Linear, Jira, Claude, Anthropic, OpenAI's Codex, Apple, Linux, Asana, Cloudflare, Datadog, Grafana, LangGraph, GitHub in content) | `BrandIcon` in `apps/vinaya-portal/src/process/components/BrandIcon.tsx`, which paints [simple-icons](https://simpleicons.org) paths in `currentColor`. A new brand is added to its `Brand` type and its `paths` map. |
| The products, the agents and the subjects of the Linear index, plus the roadmap junction | The product-icon registry: `ELEMENT_ICONS` in `apps/vinaya-portal/src/app/(site)/_components/icons/registry.ts`, whose drawings live beside it in that folder on the shared `Glyph`. A new product, agent or index subject’s icon is drawn in that folder and registered there; a page picks it from `ELEMENT_ICONS` (or `iconForHref`), never by importing a drawing directly. Wherever a heading, card, table cell or menu item shows a product, agent or subject name, its icon comes from the one name lookup `iconForName` (or `NamedIcon`) beside the name; a name with no drawing shows none. |
| A mark the site's chrome shows — the company's own (Atta Labs and its products) and GitHub's | The marks folder, `apps/vinaya-portal/src/ui/footer/marks/` |

No other icon library (`react-icons`, Heroicons, Phosphor, Tabler, `@radix-ui/react-icons`), and no icon drawn anywhere else: an inline `<svg>` in a page or component that is an icon belongs in the registry or the marks folder. A diagram, a chart or an illustration is not an icon; it still takes every colour from the variables above.

## Code that already breaks a rule

Some of the portal's code predates these rules. The rules hold for every line written from now on: new code follows them, an edit does not add a violation, and a violation an edit touches is fixed rather than copied.
