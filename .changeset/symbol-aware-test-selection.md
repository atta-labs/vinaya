---
"@attalabs/vinaya": patch
---

The pre-push test selector now resolves a bare workspace-package import through the target package's exported names instead of treating it as a dependency on the whole package. `import { foo } from '@scope/pkg'` depends only on the files traversed to resolve `foo` — the package's declared entrypoint, every re-export hop (including re-exports that cross a package boundary), and the file that defines it — so an edit inside a widely imported package selects only the tests whose imports actually reach the changed file, not every test that imports the package.

Every import or export shape the resolver cannot prove safe keeps the original whole-package edge: namespace, default, side-effect, dynamic, and `export *`-ambiguous or cyclic imports, an unknown name, a brace list carrying anything that is not a bare identifier, a package whose entrypoint cannot be derived from its manifest, an `exports` conditions object whose declared runtime targets are not all the same file, and any file that imports one package under more than one shape at once. The refinement can over-select but never omits a truly affected test — a property held by an independent never-miss oracle over both constructed and real workspace files.

Replaying the pull-request change set that modified `aeg-core`'s `review-input-manifest.ts` (the regression that motivated this) drops the selection from 95 test files to 40, and the tests those files run from 1,918 to 992 — the 40 are genuine transitive importers of the changed symbols plus the configured always-run list — while the selector itself runs in roughly a third of a second. The local pre-push entry contract, the full CI suite, the package runner boundaries, and the `prePush.alwaysRun` list are unchanged.
