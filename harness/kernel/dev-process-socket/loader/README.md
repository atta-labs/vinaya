# harness/kernel/dev-process-socket/loader

Reads a process definition from disk and validates it (`load-process.ts`). A process declares one Flow (`flow`) or several by key (`flows`, with `default_flow`); `loadProcess(folder, { flow })` selects the run's flow, refuses an undeclared key as `unknown-flow`, and pins one digest over every declared Flow and role file. Belongs to the "Any Process, One Harness" project.

## The `provides` declaration

When `process.yaml` declares `provides` (see `../contract/README.md`), the loader resolves every path in it inside the folder and returns them as `provided`; a process that declares no `provides` loads exactly as before, with no `provided`. For example, with

```yaml
roles:
  - roles/worker
provides:
  roles:
    worker:
      doctrine: roles/worker/doctrine.md
      grants: roles/worker/grants.yaml
      output_schema: roles/worker/output.schema.json
  checks: checks.ts
  policies: policies.ts
  config_section: config-section.ts
  integration: integration.ts
```

`loadProcess(folder).provided.roles.worker.outputSchema` is the absolute path of `roles/worker/output.schema.json`. Each refusal names the field:

- `schema-violation` — a required part is absent (`provides.checks`, `provides.roles.<name>.doctrine`, …).
- `launched-role-undeclared` — a folder in `roles` has no `provides.roles.<name>`, or that declaration has no `grants` or `output_schema`.
- `declared-path-missing` / `declared-path-escapes` — a declared path does not exist, or leaves the folder.

The digest pins every declared file — doctrines, grants, output schemas, every file under a `tools` folder, and the four modules — so editing any of them changes the digest. The loader never imports a declared module; the composition roots do.
