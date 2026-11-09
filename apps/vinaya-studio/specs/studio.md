# Studio

Studio is a local web app for watching a repository's tasks. You open it with `bun apps/cli/src/index.ts studio`.

## Where it runs and what it reads

- **Only on your machine.** Studio listens only on the user's own machine. Nothing outside the machine can reach it.
- **Only the Log.** Studio reads only the repository's Log: from the log server, over its live route, or from a local folder. It never reads the forge. Anything the Log does not say, Studio does not know, and it shows that as unknown.

## Screens

Studio has three screens, reached from its header:

- **Milestones** — not built yet.
- **Tasks** — not built yet.
- **Mission Control** — the landing screen: a live board with one row per task. [`mission-control.md`](mission-control.md) describes it.

## Stack

Studio is a private web app in this repository, `@vinaya/studio` under `apps/vinaya-studio`, built on the same stack as the portal: Next, with standalone output; React; Tailwind; TypeScript.

- **Components.** Every interactive element comes from the shared component library, `@vinaya/ui`. Studio keeps only its own chrome, its header.
- **Theme.** Every page renders through the shared web shell, with the theme read from the CMS, `@vinaya/cms`, under the `vinayaStudio` product key. The theme is read on every request, not at build time. Every colour, radius and font comes from the theme's variables.
- **No fallback.** When the CMS cannot be reached, Studio renders unthemed. There are no fallback colours and no saved copy of the theme.
- **Packing.** Standalone output gives one self-contained server folder, which the CLI packs and starts.
