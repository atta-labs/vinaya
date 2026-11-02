# harness/kernel/config

Reading and validating harness configuration. Belongs to the "Any Process, One Harness" project.

- `schema/config-schema.ts` — the kernel's configuration keys (checks and their environment declarations, rings, the managed-file manifest, continuous-integration setup, the task runner, the runtime folder and the log destination) and their resolvers.
- `schema/process-config-section.ts` — the interface a process's configuration section implements: its keys, its object fragment, its cross-key refinements, its machine-wide-only keys and its resolvers.
- `loader/config-loader.ts` — the loader a process's composition creates for its composed schema: the repository-local, machine-wide, local-override and trust-anchor reads.
- `loader/config-provider.ts` — the provider kernel code reads configuration through, installed by a composition root.
