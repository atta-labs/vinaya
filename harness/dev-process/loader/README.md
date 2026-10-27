# harness/dev-process/loader

Reads a process definition from disk and validates it (`load-process.ts`). A process declares one Flow (`flow`) or several by key (`flows`, with `default_flow`); `loadProcess(folder, { flow })` selects the run's flow, refuses an undeclared key as `unknown-flow`, and pins one digest over every declared Flow and role file. Belongs to the "Any Process, One Harness" project.
