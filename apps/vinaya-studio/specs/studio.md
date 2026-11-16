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

Studio is a private web app in this repository, `@vinaya/studio` under `apps/vinaya-studio`, built on the same stack as the portal: Next, behind its own local server; React; Tailwind; TypeScript.

- **Components.** Every interactive element comes from the shared component library, `@vinaya/ui`. Studio keeps only its own chrome, its header.
- **Theme.** Every page renders through the shared web shell, with the theme read from the CMS, `@vinaya/cms`, under the `vinayaStudio` product key. The theme is read on every request, not at build time. Every colour, radius and font comes from the theme's variables.
- **No fallback.** When the CMS cannot be reached, Studio renders unthemed. There are no fallback colours and no saved copy of the theme.
- **One server.** Studio is one local application server (`src/server/host.ts`) that owns the HTTP listener. It serves application WebSocket upgrades itself, hands development hot-reload upgrades to Next, and hands every other request to Next through Next's public custom-server API. It runs under Node, uses no Bun-only API, and starts a listener only when `createStudioHost(...).listen()` is called, never on import. `createStudioHost` is the one place routes and WebSocket upgrades are registered; its clock and composition callbacks are programmatic arguments only, never configuration. `src/server/entry.ts` is the normal start: it reads `HOSTNAME` and `PORT`, listens, and stops within a bound on `SIGINT` or `SIGTERM`.
- **Packing.** Next's standalone output cannot be combined with a custom server and does not trace its files, so Studio builds with a plain `next build` and the CLI packs an explicit bundle: the production build, the host bundled for Node, and every runtime file Next's output traces and `@vercel/nft` traces from the host, kept at the same paths relative to the repository root. The host's own dependencies (`ws`) and the trace tooling are declared directly in the package that uses them, never taken from a hoisted package. The CLI starts the bundle with `node`; a checkout starts the same host from source in development mode.
