---
paths:
  - "apps/vinaya-*/**"
---

# UI components — the portal's web apps

These rules govern every web app under `apps/vinaya-*` (the portal, `apps/vinaya-portal`, today). They are one of three UI rule files, read together:

- `.claude/rules/ui-components.md` — this file: which components exist, what they are built on, and how app code uses them.
- `.claude/rules/ui-theme-tokens.md` — the CSS variables, colours, radii, fonts, inline styles and icons UI code may use.
- `.claude/rules/ui-cms-theme.md` — how the CMS theme reaches those variables, and why theme work never adds one.

Claude Code loads all three whenever it reads or edits a file under `apps/vinaya-*`. Codex reads them because the app's own `AGENTS.md` points at them. The text is the same for both agents. The `atta-labs/ui-rules` check enforces them in CI on every pull request, whichever agent wrote the change.

Adding a component to the library is a workflow of its own: the `ui-new-component` skill (`.agents/skills/ui-new-component/SKILL.md`) walks it step by step.

## Where components live

The portal's component library is `apps/vinaya-portal/src/ui`. App code imports from it through the `@/ui` alias:

| Import | What it holds |
| --- | --- |
| `@/ui/components` | The interactive and display components: `Button`, `Badge`, `Card`, `Dialog`, `Sheet`, `Popover`, `Tabs`, `Toggle`, `RadioGroup`, `Collapsible`, `Command`, `Breadcrumb`, `Sidebar*`, `Table`, `Separator`, `Code`, `ChromeFrame`, `TerminalCommand`. `src/ui/components/index.ts` is the list. `NavigationMenu` (`src/ui/components/navigation-menu.tsx`) is used only inside the library, by the top bar. |
| `@/ui/shared` | Typography and layout: `Heading`, `Text`, `Flex`, `Logo`. |
| `@/ui/lib/next-link` | `NextLink`, the one link component, with its `variant` set (`prose`, `link`, `nav`, `subtle`, `card`, `destructive`, `unstyled`, `button`). |
| `@/ui/topbar`, `@/ui/footer` | The site's chrome. |
| `@/ui/lib/utils` | `cn`, which merges class names. |

## Rule 1 — every component is built in the library, on an Ariakit primitive

Every UI component lives in `apps/vinaya-portal/src/ui` and takes its behaviour from an [Ariakit](https://ariakit.org) primitive (`@ariakit/react`). Focus management, keyboard handling, ARIA state, dismissal and positioning come from Ariakit; a component never reimplements them by hand, and the library imports no other headless library (no Radix, Base UI, Headless UI or React Aria).

The library today pairs each shadcn component with its Ariakit primitive:

| Component | Ariakit primitive |
| --- | --- |
| `Button`, `Toggle`, `TerminalCommand`'s copy button | `Button` |
| `Dialog`, `Sheet` | `Dialog`, `DialogProvider`, `DialogDisclosure`, `DialogDismiss`, `DialogHeading`, `DialogDescription` |
| `Popover` | `Popover`, `PopoverProvider`, `PopoverDisclosure`, `PopoverAnchor` |
| `Tabs` | `TabProvider`, `TabList`, `Tab`, `TabPanel` |
| `RadioGroup` | `RadioProvider`, `RadioGroup`, `Radio` |
| `Collapsible` | `DisclosureProvider`, `Disclosure`, `DisclosureContent` |
| `Command` | `ComboboxProvider`, `Combobox`, `ComboboxList`, `ComboboxItem`, `ComboboxGroup` |
| `NavigationMenu` | `MenuProvider`, `MenuButton`, `Menu`, `MenuItem` |
| `Separator` | `Separator` |
| `Breadcrumb`, `Sidebar*`, any `asChild` part | `Role` |

A purely presentational part — a card, a badge, a code span, a table cell — has no behaviour for Ariakit to supply and renders a styled element; where it accepts `asChild` or `render`, it renders through Ariakit's `Role`. The moment a part gains behaviour (it opens, closes, selects, focuses or moves focus), that behaviour comes from the matching Ariakit primitive.

### shadcn's names and props, Ariakit underneath

Each component keeps the name, the part names and the props of its [shadcn/ui](https://ui.shadcn.com) counterpart, so a call site reads as shadcn code:

- Part names follow shadcn: `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogClose`; `TabsList`, `TabsTrigger`, `TabsContent`; `CardHeader`, `CardTitle`, `CardContent`.
- Props follow shadcn: `variant` and `size` (through `class-variance-authority`'s `cva`, typed with `VariantProps`), `className`, `asChild`, `open` / `defaultOpen` / `onOpenChange`, `value` / `defaultValue` / `onValueChange`.
- A component translates shadcn's props to Ariakit's inside the library: `onOpenChange` becomes the provider's `setOpen`; `asChild` becomes Ariakit's `render` through `singleChild` and `resolveRender` in `src/ui/lib/slot.tsx`. Ariakit's own prop names (`setOpen`, `store`, `render`) never reach a call site.
- Each part carries `data-slot='<part-name>'`, as shadcn's do, and states as `data-*` attributes, so styling hooks onto state rather than onto markup.
- Components are named exports, listed in `src/ui/components/index.ts`.

### Animated with `motion`

A component that animates — hover and tap scale, enter and exit, a moving indicator, a layout change — does it with [`motion`](https://motion.dev), imported from `motion/react`, passed to Ariakit as the rendered element (`render={<motion.button … />}`), as `Button` does. It honours the visitor's reduced-motion setting: `useReducedMotion()` turning the motion off, or `<MotionConfig reducedMotion='user'>` around it, as `Tabs` and `NavigationMenu` do. Tailwind's `transition-*` utilities stay fine for a plain colour or opacity change. No other animation library is added, and `framer-motion`, which `motion` superseded, is never imported directly.

## Rule 2 — app code uses the components, never raw interactive HTML

Outside `src/ui`, app code renders interactive UI only through the library's components. These raw elements never appear in a page or an app component:

| Raw element | Use instead |
| --- | --- |
| `<button>` | `Button` (or `Toggle` for a pressed state) |
| `<a>`, `next/link` used directly | `NextLink` from `@/ui/lib/next-link` |
| `<input>`, `<textarea>`, `<select>`, `<option>` | the library's field component; add it if it is missing (Rule 3) |
| `<dialog>`, a hand-built overlay | `Dialog` or `Sheet` |
| `<details>` / `<summary>` | `Collapsible` |
| any element with `onClick`, `onKeyDown`, `tabIndex` or an interactive `role` | the component whose behaviour that is |

Text goes through `Heading` and `Text` from `@/ui/shared`, set by their props (`variant`, `size`, `weight`, `family`, `tone`, `leading`) rather than by type classes.

Library components are used as the library ships them: their own `variant` and `size` pick the look. Tailwind classes passed to a library component at a call site are for layout only — grid, gap, margin, width, position. A look that every call site would want belongs in the component's variants, inside the library; a look that only one container wants goes on that container.

## Rule 3 — a missing component is added to the library, never hand-rolled in a page

When the component a page needs does not exist in `src/ui` — a select, a tooltip, an accordion, a menu, a checkbox, a segmented control — it is added to the library, built on its Ariakit primitive, under shadcn's name and props, and then imported. It is never improvised in the page from a `Button` plus state, a `div` plus a click handler, or a hand-positioned box.

These thoughts mean a hand-rolled component is about to be written; stop and add it to the library instead:

- "A quick tab bar out of a few `Button`s is enough here."
- "A `div` with `onClick` will do for this one."
- "I'll wrap this in `motion.div` myself, the library has nothing for it."
- "It's only this one page, I'll inline it."

A composite the library lacks — a banner, a rail, a choice card — is composed in the app from library components (`Card`, `Button`, `Text`), never drawn from raw elements.

## Code that already breaks a rule

Some of the portal's code predates these rules. The rules still hold for every line written from now on: new code follows them, an edit to an existing file does not add a violation, and where the edit touches a violation it is fixed rather than copied.
