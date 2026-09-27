---
'@attalabs/vinaya-sources': patch
---

The `doctrine` command's reference entry now lists `--template <name>`, which prints a template the package ships, alongside its existing `--role`, `--print`, and `--json` options — so the option surfaces in `vinaya doctrine --help` and in the generated command reference, matching what `apps/cli/src/commands/doctrine.ts` already implements.
