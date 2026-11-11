# harness/processes/minimal

A tiny second process, beside Vinaya: one role (`worker`, no tool granted), one flow (a mechanical step, an agent step for the worker, a closing mechanical step), and the declaration the process contract asks for (`process.yaml`, `harness/kernel/dev-process-socket/contract/README.md`). `integration.ts` implements the kernel's `ProcessIntegration` and imports nothing from any other process.

It exists to prove the kernel runs a process that is not Vinaya. `minimal-process.test.ts` loads it with the kernel's loader, installs it with the kernel's install call, and runs its flow on the Engine runtime with a scripted stand-in for the worker, so it needs no network and no subscription. It is a test process: it is not shipped in the package.
