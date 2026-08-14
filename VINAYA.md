<!-- Managed by Vinaya — created by `vinaya init`. `vinaya upgrade` regenerates it; `vinaya eject` removes it. -->
# Vinaya doctrine — read this first

This repo is governed by Vinaya. The full, canonical doctrine (roles,
contracts, the state machine, the ring gates) ships inside the installed
`@attalabs/vinaya` npm package itself — no in-repo copy to drift, and
`vinaya upgrade` regenerates this pointer if the install location changes.

An agent working in this repo follows the governed flow by reading two things:

1. **This pointer** — the tool-agnostic entry point at the conventional
   reading-order path (repo root). It names where the doctrine lives.
   Start at `/private/tmp/v875/apps/cli/aeg-root/skills/aeg/SKILL.md` — the doctrine's own
   front door, read first every session regardless of role.
2. **`vinaya.config.json`** — the ruleset the gates enforce: rings, custom checks,
   and the brief schema a PR/Issue body must satisfy.

Live task status is derived from the forge (Issues, labels, comments) via
`vinaya check` — it is never written into a file here.

To read the doctrine text, it is bundled at this install's own resolved
path:

    /private/tmp/v875/apps/cli/aeg-root

`vinaya doctor` reports what is installed in this repo.
