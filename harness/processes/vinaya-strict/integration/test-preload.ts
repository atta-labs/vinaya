/**
 * The process's `[test] preload` (the root, command-line and process
 * `bunfig.toml` files name it): the kernel's generic test preload first —
 * cleared credential and host variables, a private runtime directory, the
 * spawn environment wrapper, the abandoned-fixture sweep and the real-runtime
 * guard — then the two installs a Vinaya test process needs, in one call on
 * Vinaya's declared integration: the configuration provider and the Log sink
 * factory (registered deferred, so the sink loads the first time a test logs).
 */
import '../../../kernel/conformance/unit/test-env-preload.ts'

/**
 * The composition root a test process has: kernel code (`run-paths.ts`,
 * `log-sink.ts`) reads configuration through the provider the CLI entry point
 * installs, and the Log client builds its default sink only from an installed
 * factory, so every code path a test reaches through the bare `log`/`logSync`
 * gets the sink the product gets. Imported after the environment above is
 * cleaned, so nothing the composition loads reads the variables the kernel
 * preload removes.
 */
const { installProcess } = await import('../../../kernel/dev-process-socket/contract/install-process.js')
const { vinayaProcessIntegration } = await import('./process/process-integration.js')
installProcess(vinayaProcessIntegration, ['config', 'log'])
