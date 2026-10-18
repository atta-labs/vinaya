#!/usr/bin/env bun
// Fixture: moves into the directory named by its first argument, loads the
// Vinaya configuration there, and exits 0 — proves what an invalid config
// file does to the standard error of a check that loads configuration.
import { loadConfig } from '../../../src/lib/config'

process.chdir(process.argv[2] as string)
loadConfig()
process.exit(0)
