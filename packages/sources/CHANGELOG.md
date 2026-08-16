# @atta/vinaya-sources

## 0.8.0

### Minor Changes

- 9cfa0c7: Recover the `vinaya studio` command the extraction dropped.
  
  Four files (`commands/studio.ts`, `lib/studio-bundle.ts`, `scripts/bundle-studio.ts`, `tests/studio.test.ts`) lived at `apps/vinaya/cli/**` in the attalabs monorepo. The extraction moved the CLI to this repository without them, and attalabs then deleted the directory they were in — the command survived only in that repo's history, absent from both repos, the router, and the published tarball, with no gate noticing.
  
  They are recovered here against the two-repo reality: Studio's source (`apps/vinaya/web`) stayed in attalabs, so the workspace branch of `resolveStudioTarget` serves only checkouts that carry that tree, and no published build bundles the standalone Studio app. Rather than fixing import paths and shipping a command that resolves nothing, the recovered command refuses explicitly (exit 1, message naming the package) in every shape it cannot yet serve. `bundle-studio.ts` is recovered as pack-shape knowledge but deliberately not wired into `prepack` or the `files` allowlist — producing and shipping the bundle is the separate Studio-packaging task, so the published artifact's contents are unchanged.
  
  `@atta/vinaya-sources` gains the matching `studio` row in the `COMMANDS` registry, with an honest description of what the command does and does not yet do; `verify-published-lifecycle.ts` exercises the refusal for real against the packed artifact.

### Patch Changes

- @atta/aeg-core@0.8.0
  - @atta/aeg-forge-state@0.8.0
  - @atta/aeg-types@0.8.0

## 0.7.1

### Patch Changes

- 334c9d4: The four engine packages are now publicly published: `private: true` dropped, `publishConfig.access: "public"` added, and `.changeset/config.json`'s `privatePackages.tag` flipped to `true`. First public versions of `@atta/aeg-core`, `@atta/aeg-types`, `@atta/aeg-forge-state` and `@atta/vinaya-sources` ship on the next `changeset publish`, alongside `@attalabs/vinaya` as the same fixed-group version.
- Updated dependencies [334c9d4]
  - @atta/aeg-core@0.7.1
  - @atta/aeg-types@0.7.1
  - @atta/aeg-forge-state@0.7.1

## 0.7.0

### Minor Changes

- a0d413a: Adopter-declared CI setup: a new optional `ci.setup` key in `vinaya.config.json`, emitted verbatim as an "Adopter CI setup" step in the generated workflows that execute `vinaya check` (checks, review, review-verdict — never the archivist, whose jobs spawn no adopter code).
  
  The generated jobs previously installed node and nothing else — correct for vinaya's own checks, which arrive whole via `npx`, and fatal for an adopter's custom checks, which are scripts in the adopter's own repository that may import the adopter's own code. Measured on the first non-greenfield adopter: both of its custom checks failed as `error (2ms)` spawn failures on every CI run while passing in the local hooks, turning a required check permanently red.
  
  The command is declared in the committed config, never inferred — vinaya cannot know an adopter's package manager or runtime. When the key is absent, the generated workflows are byte-identical to before it existed, so existing installs see no churn. Note for repos that do declare it: the generated workflows are managed artifacts, so the next `vinaya upgrade` after declaring the key rewrites their bytes — that is the intended delivery path, not drift.
  
  `@atta/vinaya-sources` gains the matching `ci` / `ci.setup` rows in the adopter-facing config reference.

### Patch Changes

- @atta/aeg-core@0.7.0
  - @atta/aeg-forge-state@0.7.0
  - @atta/aeg-types@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [6a3f006]
- Updated dependencies [dbb8acd]
  - @atta/aeg-core@0.6.0
  - @atta/aeg-forge-state@0.6.0
  - @atta/aeg-types@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [d4a12db]
  - @atta/aeg-core@0.5.0
  - @atta/aeg-forge-state@0.5.0
  - @atta/aeg-types@0.5.0
