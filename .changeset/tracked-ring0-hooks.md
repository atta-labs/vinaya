---
"@attalabs/vinaya": minor
---

Ring 0 now survives a clone (atta-labs/attalabs#927). Non-husky installs write git hooks into a TRACKED `.vinaya/hooks/` directory routed via `git config core.hooksPath .vinaya/hooks` instead of the unversioned `.git/hooks` — hook files travel with the repo into every clone and every linked worktree checkout, where before a fresh clone silently had zero ring-0 enforcement while the manifest still claimed the hooks existed.

What changes for adopters:

- **New installs** (`vinaya init`, no husky, no active raw `.git/hooks` hooks): hooks land in `.vinaya/hooks/` (commit them) and the installing clone is armed automatically. Each FRESH clone runs `git config core.hooksPath .vinaya/hooks` once — the one thing git cannot version. `vinaya doctor` reports an unarmed clone as an error and names that exact command; `vinaya upgrade` also arms it.
- **Existing `.git/hooks` installs**: the next `vinaya upgrade` migrates — tracked copies land first, legacy hosts are stripped, the config is armed, and the manifest's hook paths are rewritten. The migration REFUSES (and says why, and `doctor` keeps warning) whenever arming would silently disable hooks vinaya does not own: adopter lines in a hook host, or any unmanaged active raw hook in `.git/hooks`.
- **Husky installs**: unchanged.
- **`vinaya eject`**: also unsets `core.hooksPath` when it still points at vinaya's own tracked dir.
- The managed-manifest version bumps 1 → 2 (shape unchanged) so an older package meeting a migrated manifest refuses loudly instead of half-understanding the recorded hook locations.
