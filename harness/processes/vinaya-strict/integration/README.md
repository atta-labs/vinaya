# harness/processes/vinaya-strict/integration

How the Vinaya process attaches to the harness. Belongs to the "Any Process, One Harness" project.

`config/` holds Vinaya's configuration section (`vinaya-config-section.ts`) and its composition with the kernel's keys into the one schema and loader (`compose.ts`), which `apps/cli/src/lib/config.ts` re-exports.
