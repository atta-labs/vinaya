# 0016. Vinaya web apps share one UI package and one CMS package

**Status:** Accepted

**Date:** 2026-11-07

## Context

Record [0011](0011-portal-ui-on-ariakit-and-cms-theme-variables.md) placed the component library inside the portal, at `apps/vinaya-portal/src/ui`, and the portal's Sanity client, its queries and the theme's renderer sat beside it in `apps/vinaya-portal/src/cms`. The portal was then the only web app. A second web app, the Studio, is coming, and it needs the same components, the same CMS reads and the same theme rendering. A second app cannot import another app's source folder, and a copy of either folder would drift from the original with the first edit to one of them.

The portal came into this repository from the Atta Labs monorepo, where the UI and the CMS code were shared packages. The portal's copies have changed since, and nothing in this repository reads the Atta Labs repository: the portal builds from this repository's own files alone.

## Decision

We will hold the code every Vinaya web app shares in two private workspace packages: one UI package, `packages/ui`, holding the component library, and one CMS package, `@vinaya/cms` at `packages/cms`, holding the Sanity client resolved by product key, the product, branding and theme queries, the theme-to-CSS renderer with its CSS safety guard, the colour conversion, the font loader and the favicon builder. Every web app reads its components and its CMS content through these two packages and never keeps its own copy.

Both packages are built inside this repository from the portal's own files, and take nothing from any other repository: no file is copied from the Atta Labs repository and no package depends on one published from it.

A query that reads only one app's own content stays in that app and builds its client from the CMS package.

The rest of record 0011 stands: components on Ariakit under shadcn's names and props, colours, radii and fonts only from the CMS theme's variables, and one set of rule files for Claude Code and Codex alike. This record replaces only its placement of the library inside the portal.

## Considered options

- Keep the library and the CMS code inside the portal, and let each new app copy what it needs. This costs nothing now, but every copy drifts from the original, and a theme fix made in one app never reaches the other.
- Depend on the Atta Labs repository's shared packages. The packages exist there, but this repository's copies have moved on from them, and a dependency on another repository makes every web app's build depend on code this repository does not review.
- Move the shared code into two packages built in this repository. This is the chosen option: each app imports one copy, a change to a component or to the theme's rendering reaches every app in the same change, and the build reads only this repository.

## Consequences

A second web app gets the portal's components, CMS reads and theme rendering by adding two workspace dependencies. A change to either package changes every app that imports it, so the package carries its own tests: the CMS package proves its renderer still turns the recorded theme corpus into the CSS it rendered before it moved. Each Next app lists both packages in `transpilePackages`, because the packages ship TypeScript source. The UI rules check scans added lines in both package folders as it scans the web apps, and the CMS theme rule covers both folders, so the rules follow the code into the packages.

## Where it is applied

`packages/cms` is the CMS package, `@vinaya/cms`; `packages/cms/src/theme.test.ts` holds its renderer test against `packages/cms/src/utils/theme-corpus.fixture.json`. `apps/vinaya-portal/package.json` depends on it and `apps/vinaya-portal/next.config.ts` lists it in `transpilePackages`. The roadmap query, which reads only the portal's content, is `apps/vinaya-portal/src/lib/roadmap-milestones.ts`. `packages/ui` is the UI package's folder; until the component library moves there, the library stays at `apps/vinaya-portal/src/ui`. `scripts/vinaya-checks/ui-rules.ts` scans both package folders, and `.claude/rules/ui-cms-theme.md` covers them in its `paths`.
