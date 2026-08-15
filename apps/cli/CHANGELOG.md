# @attalabs/vinaya

## 0.5.0

### Minor Changes

- d4a12db: Remove the `vinaya studio` command and its bundled Studio assets from the published CLI.
  
  `studio` was a documented command in the README's command table. An adopter
  running it after upgrading now gets an unknown command — that is a breaking
  change for anyone using it, not an internal cleanup. The published tarball
  also shrinks from ~85.7 MB to ~743 kB as a direct result. Bumped `minor`
  rather than `patch`: pre-1.0 semver convention treats `minor` as the
  breaking-change slot, and a silent `patch` would misrepresent the removal's
  impact.
  
  Also bundled in this release, since none of it has been published yet:
  
  - Fix: resolve the vendored CLI correctly in generated git hooks
  - Fix: address code-review findings from the Studio-removal PR
  - Fix: make the reader-facing no-op sentinel structurally safe
  - Feat: add Changesets with a fixed-group cascade (the mechanism that
    produced this release)
