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
- **One-time session.** Every launch makes a fresh secret and hands it, with the repositories to observe, to the server over its standard input (`src/server/session.ts`, `src/server/repositories.ts`). The launcher opens the browser on `/__studio/bootstrap?token=<secret>`, the only unauthenticated route. It accepts one `GET` addressed to the server's exact local host, from no Origin or this server's own, and only before its ten-minute expiry; it consumes the secret, sets an HttpOnly, `SameSite=Strict` cookie and redirects to `/`, with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, so the secret never stays in the address and no page, script or CMS request sees it. A reused, expired or malformed link, or a wrong secret, sets no cookie and reads nothing; a wrong secret does not spend the real one. Every other request needs the cookie, the exact local `Host`, no `Sec-Fetch-Site: cross-site`, and no `Origin` other than this server's own: a safe `GET` or `HEAD` may carry none (a navigation or a same-origin asset), a request that changes state must name it. Every WebSocket upgrade, the application's and Next's hot reload alike, needs the cookie and exactly this server's own `Origin`. The session lives in memory: closing Studio ends it.
- **Repositories.** Studio observes the checkouts the launcher names: the current directory's (a nested folder or a linked worktree resolves to its top-level folder), or each `--repo <path>`. A browser never picks a path, and nothing scans the machine. The launcher resolves each root and its `origin` identity from local git, never the forge. `resolveStudioRepositories` then reads each root's own `vinaya.config.json` (else the machine-wide file) with the checked rules, never changing the working directory, and resolves its Log source: the default local folder when `logs` is unset, a configured folder, or a server with its raw `logs.readHeaders`. An invalid configuration, `logs: false`, or a `readHeaders` reference with no value in the environment is reported by name, never by value, and never replaced by another source. `/api/mission-control/repositories` lists each repository and the state of its source for the signed-in browser; it carries no header and no credential. The Log ingest token, forge tokens and `*_API_KEY` variables are not passed to the server.
- **Packing.** Next's standalone output cannot be combined with a custom server and does not trace its files, so Studio builds with a plain `next build` and the CLI packs an explicit bundle: the production build, the host bundled for Node, and every runtime file Next's output traces and `@vercel/nft` traces from the host, kept at the same paths relative to the repository root. The host's own dependencies (`ws`) and the trace tooling are declared directly in the package that uses them, never taken from a hoisted package. The CLI starts the bundle with `node`; a checkout bundles the same host for Node just before it starts, and runs it in development mode.
