#!/usr/bin/env bun
/**
 * {{CHECK_NAME}} — an explicit no-op, scaffolded by `vinaya new noop-check`.
 *
 * Registering this under `checks.{{CHECK_NAME}}` REPLACES the core check of
 * the same name — the core one stops running. This is the only sanctioned
 * way to silence a core check: an explicit, contract-satisfying no-op,
 * rather than deleting the registration or disabling the gate some other
 * way. Always exits 0. Emits no findings. This file is standalone (no
 * import from the vinaya CLI's own source tree) because it lives in YOUR
 * repo, not inside `@attalabs/vinaya`.
 *
 * INTENTIONAL SILENCING — replace this line with the real reason
 * "{{CHECK_NAME}}" is disabled for this repo, so a future reader finds out
 * why rather than assuming the gate broke.
 */

process.exit(0)
