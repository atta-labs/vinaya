import { afterEach, describe, expect, test } from 'bun:test'
import {
  type ConfigProvider,
  configProvider,
  hasConfigProvider,
  installConfigProvider,
  NO_CONFIG_PROVIDER_MESSAGE,
  uninstallConfigProvider
} from './config-provider'

const fake = (homeDir: string): ConfigProvider => ({
  homeDir,
  loadConfig: () => ({ runtimeDir: `${homeDir}/runs` }),
  loadTrustAnchorConfig: () => null,
  loadTrustAnchorConfigAsync: async () => null
})

describe('the configuration provider', () => {
  const previous = uninstallConfigProvider()
  afterEach(() => {
    uninstallConfigProvider()
    if (previous) installConfigProvider(previous)
  })

  test('a read with no provider installed is refused, naming the call that installs one', () => {
    uninstallConfigProvider()
    expect(hasConfigProvider()).toBe(false)
    expect(() => configProvider()).toThrow(NO_CONFIG_PROVIDER_MESSAGE)
    expect(NO_CONFIG_PROVIDER_MESSAGE).toContain('installConfigProvider()')
  })

  test('an installed provider answers every read, and a later install replaces it', () => {
    installConfigProvider(fake('/home/a'))
    expect(configProvider().homeDir).toBe('/home/a')
    expect(configProvider().loadConfig()).toEqual({ runtimeDir: '/home/a/runs' })
    installConfigProvider(fake('/home/b'))
    expect(configProvider().homeDir).toBe('/home/b')
  })

  test('uninstalling returns the provider it removed', () => {
    const provider = fake('/home/c')
    installConfigProvider(provider)
    expect(uninstallConfigProvider()).toBe(provider)
    expect(hasConfigProvider()).toBe(false)
  })
})
