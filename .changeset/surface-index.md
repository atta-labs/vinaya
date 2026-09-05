---
"@attalabs/vinaya": patch
---

Adds `apps/cli/specs/surface.md`, the public function index: policy (`@attalabs/aeg-core`), effects (`apps/cli/src/lib`), and one row per shipped command naming the lib function it should call, with dated exemptions for commands that call more than one today. `apps/cli/tests/surface-index.test.ts` enforces it against the real source tree via the TypeScript compiler API. No command behavior changes.
