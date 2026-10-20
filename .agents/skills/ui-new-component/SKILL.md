---
name: ui-new-component
description: Add a missing UI component to the portal's component library — an Ariakit primitive under shadcn's name and props, styled only with the CMS theme's variables, animated with motion — then use it from app code.
---
# Add a component to the portal's library

Use this when a page or app component under `apps/vinaya-*` needs a UI component the library at `apps/vinaya-portal/src/ui` does not have: a select, a tooltip, a dropdown menu, a checkbox, an accordion, a hover card, a toolbar. The component is added to the library and then imported; it is never hand-rolled in the page.

This workflow follows the three UI rule files at the repository root. Read all three first; every step below assumes them:

- `.claude/rules/ui-components.md` — the library, Ariakit underneath, shadcn's names and props, `motion`, no raw interactive HTML in app code.
- `.claude/rules/ui-theme-tokens.md` — the CSS variables the CMS theme renders, and nothing else, for colours, radii and fonts; inline styles and icons.
- `.claude/rules/ui-cms-theme.md` — how the theme reaches those variables, and why no step here adds one.

## 1. Confirm the component is missing

Read `apps/vinaya-portal/src/ui/components/index.ts` and `apps/vinaya-portal/src/ui/libraries/shared/components/index.ts`. If the component is there under its shadcn name, use it. If what the page needs is a composite (a banner, a choice card, a rail), compose it in the app from existing components (`Card`, `Button`, `Text`); it is not a library component. Continue only for a real primitive the library lacks.

## 2. Find its two references

- **Its shadcn counterpart** — `https://ui.shadcn.com/docs/components/<name>`. Take from it the component's name, its part names (`Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`), its props (`value`, `defaultValue`, `onValueChange`, `open`, `onOpenChange`, `disabled`, `asChild`), its `variant` and `size` sets, and its classes as a starting point for the look.
- **Its Ariakit primitive** — `https://ariakit.org/components/<name>`. The behaviour comes from here. The usual pairs:

  | shadcn component | Ariakit primitive |
  | --- | --- |
  | `Select` | `Select` (`SelectProvider`, `Select`, `SelectPopover`, `SelectItem`) |
  | `Tooltip` | `Tooltip` (`TooltipProvider`, `TooltipAnchor`, `Tooltip`) |
  | `DropdownMenu`, `ContextMenu` | `Menu` (`MenuProvider`, `MenuButton`, `Menu`, `MenuItem`) |
  | `Menubar` | `Menubar` |
  | `Checkbox` | `Checkbox` |
  | `Accordion` | `Disclosure` |
  | `HoverCard` | `Hovercard` |
  | `Toolbar`, `ToggleGroup` | `Toolbar` |
  | `Combobox` | `Combobox` |
  | `Form`, `Input`, `Label` | `Form` (`FormProvider`, `Form`, `FormInput`, `FormLabel`, `FormError`) |

Read the existing component whose primitive is closest — `src/ui/components/popover.tsx` for anything that opens, `tabs.tsx` for a selection with an animated indicator, `toggle.tsx` for a pressed state, `button.tsx` for variants and `motion` — and follow its shape.

## 3. Write the component

Create `apps/vinaya-portal/src/ui/components/<shadcn-name-in-kebab-case>.tsx`:

1. `'use client'` at the top when the component holds state or handlers; import `* as Ariakit from '@ariakit/react'`, `cn` from `../lib/utils`, and `cva` / `VariantProps` from `class-variance-authority` when it has variants.
2. One function per shadcn part, named as shadcn names it, each rendering its Ariakit primitive.
3. Translate shadcn's props to Ariakit's inside the component, never at the call site: `onOpenChange` to the provider's `setOpen`, `onValueChange` to `setValue`, `asChild` to `render` through `resolveRender` from `../lib/slot`. A presentational part with no behaviour renders a styled element, through `Ariakit.Role` when it takes `asChild`.
4. Put `data-slot='<part-name>'` on each part, and style states through the `data-*` and `aria-*` attributes Ariakit sets (`aria-expanded:`, `data-active-item:`, `aria-selected:`).
5. Style only with the variables in `.claude/rules/ui-theme-tokens.md`, through Tailwind's semantic classes: `bg-popover text-popover-foreground` for a floating surface, `hover:bg-accent hover:text-accent-foreground` for a hover fill, `focus-visible:ring-ring/50` for focus, `rounded-md` for a radius. No palette class, no literal colour, no new variable, no inline style except a runtime-computed value.
6. Animate with `motion` from `motion/react`, passed as the Ariakit element (`render={<motion.div … />}`), and honour reduced motion with `useReducedMotion()` or `<MotionConfig reducedMotion='user'>`.
7. Icons inside the component are `lucide-react` (`ChevronDownIcon`, `CheckIcon`, `XIcon`).
8. Export each part and its `…Props` type by name at the bottom of the file.

## 4. Add it to the library's index

Add the exports to `apps/vinaya-portal/src/ui/components/index.ts`, in the file's alphabetical order, so app code imports it from `@/ui/components`.

## 5. Use it

Import it in the page from `@/ui/components` and pass only shadcn's props: its `variant` and `size` for the look, Tailwind classes for layout only. If the page held a hand-rolled version, delete that version in the same change.

## 6. Check it

- Run `bun run --cwd apps/vinaya-portal dev` and open the page in both colour schemes: the component follows the theme in light and dark, works with the keyboard alone (Tab, the arrow keys, Enter, Escape), and holds still with the system's reduced-motion setting on.
- Search the new file for literals: `grep -nE "#[0-9a-fA-F]{3,8}\b|oklch\(|hsla?\(|rgba?\(|style=\{" apps/vinaya-portal/src/ui/components/<name>.tsx` prints nothing, apart from a `style` that carries a runtime-computed value.
- Commit: the commit hook formats, lints and typechecks the portal; CI runs the `atta-labs/ui-rules` check, which enforces the three rule files.
