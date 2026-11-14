/**
 * The listing probe ships in the selection package (`listing-probe.ts` of `@attalabs/test-selection`), which the
 * recorder copies beside each run and preloads (`copyListingProbe`). What this repository names of it — the log
 * variable and the path helpers the probe logs folders through — comes from the package entrypoint, which never
 * imports the probe itself, since importing the probe installs it.
 */
export { absoluteOf, globPrefix, PROBE_LOG_ENV } from '@attalabs/test-selection'
