# harness/kernel/dev-process-socket/contract

The schema every process definition satisfies (`process.schema.json`): `id`, `version`, `roles`, and exactly one of `flow` or `flows` (Flow files by key, with an optional `default_flow`). Belongs to the "Any Process, One Harness" project.

## What a process provides

A process may also declare `provides`, naming everything else it supplies. Every value is a path inside the process folder:

- `roles` — every role by name. Each declares its `doctrine`; a launched role (a folder listed in `roles`, matched by the folder's last segment) also declares its `grants` and `output_schema`; a role with its own tools folder declares `tools`.
- `checks`, `policies`, `config_section` — the module that supplies the check registry, the broker, worker-boundary, tool-grant and router policies, and the configuration section.
- `integration` — the one module that implements `ProcessIntegration` (`process-integration.ts`).

```yaml
id: sample
version: 1.0.0
flow: flow.yaml
roles:
  - roles/worker
provides:
  roles:
    worker:
      doctrine: roles/worker/doctrine.md
      grants: roles/worker/grants.yaml
      output_schema: roles/worker/output.schema.json
    planner:
      doctrine: planner/doctrine.md
      tools: planner/tools
  checks: checks.ts
  policies: policies.ts
  config_section: config-section.ts
  integration: integration.ts
```

`process-integration.ts` is the TypeScript interface the `integration` module implements. Each member is typed by the kernel slot it fills: `checks` by `installCheckRegistry`; `policies` by `createBroker`, `createWorkerBoundary`, `createTaskToolRouter` and the dev-tools host's `toolGrants`; `config` by `installConfigProvider` plus the process's configuration section; `log` by `installDefaultLogSinkFactory` and `registerDeferredLogSinkFactory`. The kernel imports no process module; a composition root imports the integration.
