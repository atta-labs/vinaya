---
paths:
  - "apps/vinaya-*/**"
---

# The CMS theme — how the portal's variables get their values

These rules govern every web app under `apps/vinaya-*`. They are one of three UI rule files, read together: `.claude/rules/ui-components.md` (components), `.claude/rules/ui-theme-tokens.md` (the variables UI code may use) and this file (how the CMS theme reaches those variables). Claude Code loads them for any file under `apps/vinaya-*`; Codex is pointed at them by the app's `AGENTS.md`. The `atta-labs/ui-rules` check enforces them in CI on every pull request, whichever agent wrote the change.

## Where the theme lives

The portal's look is data, not code. It lives in Sanity:

- **The theme document** — a `uiTheme` in the Atta Labs Sanity project (product key `attalabs`): its `light` and `dark` colour groups, `typography` (`fontSans`, `fontSerif`, `fontMono`, `trackingNormal`), `spacing` (`radius`, `spacing`) and `shadows` (the shadow ramp). Its colour fields build on [shadcn's theming variables](https://ui.shadcn.com/docs/theming) and add the theme's own: `success`, `warning`, their foregrounds, the hover colours, the shadow colour, the header background and the gradients.
- **The portal's config** — the `vinayaPortalConfig` singleton in the Vinaya Sanity project (product key `vinayaPortal`), whose `userInterface` names the theme to use and the default colour scheme (`dark` or `light`).

Editing a colour, a font or the radius is a content change in the Sanity studio, not a code change.

## How the theme reaches the variables

1. **One read.** `getPortalCms()` in `apps/vinaya-portal/src/lib/portal-cms.ts` is the app's only CMS read. It calls `getProductCms('vinayaPortal')` (`src/cms/queries/product-cms.ts`), which reads the config singleton and resolves its theme against the Atta Labs project (`getProductConfig` in `src/cms/queries/product-ui-config.ts`). The result is cached for 60 seconds. `PORTAL_THEME_ID` and `PORTAL_COLOR_SCHEME` override the theme and the scheme for one machine without touching the CMS config.
2. **The root layout.** `apps/vinaya-portal/src/app/layout.tsx` passes the config to `NextWebShell` (`src/ui/lib/next-web-shell.tsx`) with `styleId='vinaya-theme'`, `cookieName='vinaya-color-scheme'` and `staticColorScheme`, so the site renders statically.
3. **The renderer.** `NextWebShell` calls `generateThemeCSS` (`src/cms/utils/theme.ts`), which writes both schemes — light on `:root`, dark on `:root[data-theme="dark"]` — into `<style id="vinaya-theme">`. Each colour field becomes a variable by its kebab-case name (`FIELD_TO_CSS_VAR` in `src/cms/types.ts` for the multi-word ones), its value converted to `oklch` by `cssColorToOklch` (`src/cms/utils/oklch.ts`); typography, spacing and shadows follow. Every declaration passes `toCssDeclarations` (`src/cms/utils/css-safety.ts`), which drops any name or value that could break out of its declaration or fetch a remote resource.
4. **Fonts.** `getGoogleFontsUrl` (`src/cms/utils/font-loader.ts`) turns `typography` into the Google Fonts `<link>` in `<head>`; no font is named in code.
5. **The scheme.** `<html data-theme>` starts at the CMS default; a blocking script first in `<head>` corrects it from the `vinaya-color-scheme` cookie before first paint. Tailwind's `dark:` variant follows `data-theme`, not the browser's preference. `ColorSchemeToggle` (`src/ui/lib/color-scheme-toggle.tsx`) flips the attribute, rewrites the style tag and writes the cookie. The cookie name default, the attribute and the resolution order live in `src/ui/lib/color-scheme.ts`; import them, never retype them.
6. **Tailwind.** The `@theme inline` block of `src/ui/styles/globals.css` maps the rendered variables to Tailwind's names (`--color-primary: var(--primary)`), so `bg-primary` reaches the theme.
7. **Preview.** In the admin's preview frame, `PreviewThemeListener` (`src/ui/lib/preview-theme-listener.tsx`) receives a theme by `postMessage` and `applyThemeToDOM` (`src/ui/lib/preview-theme-utils.ts`) writes its variables onto `<html>`, so an editor sees a theme before publishing it.
8. **Canvas.** Canvas and three.js code reads the live variables through `tokenHex` in `src/ui/lib/theme-color.ts`.

When the CMS cannot be reached, `getProductCms` returns `null`, no theme CSS is written, and the page renders unthemed. `globals.css` holds no fallback values: the CMS theme is the only source.

## Theme work never adds a variable

The CMS theme's variable set, listed in `.claude/rules/ui-theme-tokens.md`, is the whole set. Theme work — restyling a page, a component's variants, a dark-mode fix, a new section — chooses among those variables and never adds one:

- No new variable in `globals.css`, in a component, or in the renderer's field map. `FIELD_TO_CSS_VAR` names the theme's existing fields; it is not a place to invent names.
- No fallback values for a variable in a stylesheet or a `var(--x, …)` literal.
- A colour that seems missing is a role question: walk the role tables in `.claude/rules/ui-theme-tokens.md`, or take a shade of an existing variable through opacity.
- Exposing a variable the theme already renders to Tailwind — a `--color-*` line in `@theme inline` for `--header-background`, say — is not adding a variable, and is allowed.

A genuinely new theme field is a change to the shared theme schema in the Atta Labs Sanity project, which every product bound to that theme shares. It is decided by the Principal outside UI work, not made inside a portal change.

## Rules

- Every web app's root layout renders through `NextWebShell`; nothing replicates what it does (no `<style>` of variables per component, no second theme injection).
- App code reads the CMS through `getPortalCms()`, never through a Sanity client or a GROQ query of its own.
- A Sanity project is resolved from its product key (`createProductClient` in `src/cms/client.ts`), never from an environment variable.
- A theme looked up by id (`getThemeById`) is read from the Atta Labs project, `createProductClient('attalabs')`, where `uiTheme` documents live.
- `getProductCms` already degrades to `null` and says why outside production; never wrap it in `.catch(() => null)`.
- A theme value is CSS-guarded at the sink: anything added to `src/cms/utils/theme.ts` that writes a declaration goes through `toCssDeclarations`.
- Component CSS never overrides `--font-sans`, `--font-serif`, `--font-mono` or any other theme variable.
