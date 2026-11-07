/**
 * The process's `[test] preload` (the root, command-line and process
 * `bunfig.toml` files name it): the kernel's generic test preload first —
 * cleared credential and host variables, a private runtime directory, the
 * spawn environment wrapper, the abandoned-fixture sweep and the real-runtime
 * guard — then the two installs a Vinaya test process needs, in the order the
 * command line's entry makes them.
 */
import '../../../kernel/conformance/unit/test-env-preload.ts'

/**
 * The composition root a test process has: kernel code (`run-paths.ts`,
 * `log-sink.ts`) reads configuration through the provider the CLI entry point
 * installs, and a test that imports such a module directly never runs that
 * entry point. Imported after the environment above is cleaned, so nothing the
 * composition loads reads the variables the kernel preload removes.
 */
const { installVinayaConfigProvider } = await import('./config/compose.js')
installVinayaConfigProvider()

/**
 * The test process's composition root, as `apps/cli/src/index.ts` is the
 * command line's: the Log client builds its default sink only from an
 * installed factory, so every code path a test reaches through the bare
 * `log`/`logSync` gets the sink the product gets. Imported after the
 * environment above is settled, so the Log modules load against it exactly
 * as they did when a test file loaded them first.
 */
const { installVinayaLogSinkFactory } = await import('./log/log-sink-factory.js')
installVinayaLogSinkFactory()
