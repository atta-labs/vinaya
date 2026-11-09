import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  choosePort,
  FALLBACK_PORT,
  launchStudio,
  parsePortFlag,
  planLaunch,
  PRIMARY_PORT,
  resolveStudioTarget,
  STUDIO_HOST,
  studioEnv
} from '../src/commands/studio'
import {
  packStudioNodeModules,
  repairStudioNodeModules,
  STUDIO_APP_RELPATH,
  STUDIO_NODE_MODULES_PACKED_DIRNAME,
  studioServerDir
} from '../src/lib/studio-bundle'

const roots: string[] = []
const closers: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'studio-test-'))
  roots.push(root)
  return root
}

/** An installed package whose shipped Studio is a tiny server that reports the HOSTNAME it was started with. */
function fakeInstall(withBundle: boolean): { root: string; moduleUrl: string; bundleRoot: string } {
  const root = scratch()
  writeFileSync(join(root, 'package.json'), '{"name":"@attalabs/vinaya"}')
  mkdirSync(join(root, 'dist'), { recursive: true })
  const bundleRoot = join(root, 'studio-standalone')
  if (withBundle) {
    const serverDir = studioServerDir(bundleRoot)
    mkdirSync(serverDir, { recursive: true })
    mkdirSync(join(bundleRoot, STUDIO_NODE_MODULES_PACKED_DIRNAME, 'next'), { recursive: true })
    writeFileSync(
      join(serverDir, 'server.js'),
      `require('node:http').createServer((req, res) => res.end(process.env.HOSTNAME)).listen(Number(process.env.PORT), process.env.HOSTNAME)\n`
    )
  }
  return { root, moduleUrl: pathToFileURL(join(root, 'dist', 'index.js')).href, bundleRoot }
}

function occupy(port = 0): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, STUDIO_HOST, () => {
      closers.push(() => new Promise<void>((done) => server.close(() => done())))
      resolve({ port: (server.address() as net.AddressInfo).port })
    })
  })
}

async function freePort(): Promise<number> {
  const { port } = await occupy()
  await closers.pop()?.()
  return port
}

describe('studio target resolution', () => {
  test('a checkout is found by the app package name, walking up from a nested folder', () => {
    const root = scratch()
    const appDir = join(root, ...STUDIO_APP_RELPATH.split('/'))
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'package.json'), '{"name":"@vinaya/studio"}')
    const nested = join(root, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    expect(resolveStudioTarget(nested, fakeInstall(false).moduleUrl)).toEqual({ kind: 'checkout', appDir })
  })

  test('a folder named like the app but with another package name is not a checkout', () => {
    const root = scratch()
    const appDir = join(root, ...STUDIO_APP_RELPATH.split('/'))
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'package.json'), '{"name":"somebody-else"}')
    expect(resolveStudioTarget(root, fakeInstall(false).moduleUrl).kind).toBe('missing')
  })

  test('the shipped Studio is found inside the installed package', () => {
    const install = fakeInstall(true)
    expect(resolveStudioTarget(scratch(), install.moduleUrl)).toEqual({
      kind: 'shipped',
      bundleRoot: install.bundleRoot,
      serverDir: studioServerDir(install.bundleRoot)
    })
  })

  test('neither present is missing', () => {
    expect(resolveStudioTarget(scratch(), fakeInstall(false).moduleUrl)).toEqual({ kind: 'missing' })
  })

  test('a launch with neither refuses with a message saying the package is missing Studio', async () => {
    const errors: string[] = []
    const result = await launchStudio(scratch(), [], {
      moduleUrl: fakeInstall(false).moduleUrl,
      error: (line) => errors.push(line)
    })
    expect(result).toEqual({ exitCode: 1 })
    expect(errors.join('\n')).toContain('missing Studio')
  })
})

describe('studio host, port and launch plan', () => {
  test("the caller's HOSTNAME and PORT never win over loopback and the chosen port", () => {
    const env = studioEnv({ HOSTNAME: '0.0.0.0', PORT: '1', KEEP: 'yes' }, 3108)
    expect(env).toMatchObject({ HOSTNAME: '127.0.0.1', PORT: '3108', KEEP: 'yes' })
  })

  test('a checkout runs the app dev server with host and port on the command line, not the dev script', () => {
    const plan = planLaunch({ kind: 'checkout', appDir: '/repo/apps/vinaya-studio' }, '/repo', 3108, {
      HOSTNAME: '0.0.0.0'
    })
    expect(plan.args).toEqual(['run', 'next', 'dev', '--hostname', '127.0.0.1', '--port', '3108'])
    expect(plan.cwd).toBe('/repo/apps/vinaya-studio')
    expect(plan.env.HOSTNAME).toBe('127.0.0.1')
  })

  test('the primary port is 3008 and the fallback 3108', async () => {
    expect([PRIMARY_PORT, FALLBACK_PORT]).toEqual([3008, 3108])
    expect(await choosePort(null, async () => true)).toEqual({ ok: true, port: 3008 })
    expect(await choosePort(null, async (p) => p !== 3008)).toEqual({ ok: true, port: 3108 })
  })

  test('both default ports taken is a refusal', async () => {
    const choice = await choosePort(null, async () => false)
    expect(choice.ok).toBe(false)
  })

  test('an explicit port is used exactly, or refused when taken, never replaced by a fallback', async () => {
    expect(await choosePort(4100, async () => true)).toEqual({ ok: true, port: 4100 })
    const taken = await choosePort(4100, async (p) => p !== 4100)
    expect(taken.ok).toBe(false)
  })

  test('the port flag parses both forms and refuses a non-port', () => {
    expect(parsePortFlag([])).toEqual({ port: null })
    expect(parsePortFlag(['--port', '4100'])).toEqual({ port: 4100 })
    expect(parsePortFlag(['--port=4101'])).toEqual({ port: 4101 })
    expect('error' in parsePortFlag(['--port', 'abc'])).toBe(true)
    expect('error' in parsePortFlag(['--port'])).toBe(true)
    expect('error' in parsePortFlag(['--port', '70000'])).toBe(true)
  })
})

describe('studio launch of the shipped server', () => {
  test('binds loopback whatever HOSTNAME the caller sets, and repairs the packed dependencies folder', async () => {
    const install = fakeInstall(true)
    const port = await freePort()
    const launch = await launchStudio(scratch(), ['--port', String(port)], {
      moduleUrl: install.moduleUrl,
      env: { ...process.env, HOSTNAME: '0.0.0.0', PORT: '1' },
      openBrowser: async () => true,
      log: () => {},
      error: () => {}
    })
    if ('exitCode' in launch) throw new Error(`launch failed with exit ${launch.exitCode}`)
    closers.push(async () => {
      launch.child.kill()
      await launch.exited
    })
    expect(launch.port).toBe(port)
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    expect(body).toBe('127.0.0.1')
    expect(existsSync(join(install.bundleRoot, 'node_modules', 'next'))).toBe(true)
    expect(existsSync(join(install.bundleRoot, STUDIO_NODE_MODULES_PACKED_DIRNAME))).toBe(false)
  })

  test('falls back when the primary port is taken and the fallback is bound', async () => {
    const install = fakeInstall(true)
    const primary = (await occupy()).port
    const fallback = await freePort()
    const logs: string[] = []
    const launch = await launchStudio(scratch(), [], {
      moduleUrl: install.moduleUrl,
      ports: { primary, fallback },
      openBrowser: async () => true,
      log: (line) => logs.push(line),
      error: () => {}
    })
    if ('exitCode' in launch) throw new Error(`launch failed with exit ${launch.exitCode}`)
    closers.push(async () => {
      launch.child.kill()
      await launch.exited
    })
    expect(launch.port).toBe(fallback)
    expect((await fetch(`http://127.0.0.1:${fallback}/`)).ok).toBe(true)
    expect(logs.join('\n')).toContain(String(primary))
  })

  test('an explicit port that is taken is refused and nothing is started', async () => {
    const taken = (await occupy()).port
    const errors: string[] = []
    const result = await launchStudio(scratch(), ['--port', String(taken)], {
      moduleUrl: fakeInstall(true).moduleUrl,
      openBrowser: async () => true,
      error: (line) => errors.push(line)
    })
    expect(result).toEqual({ exitCode: 1 })
    expect(errors.join('\n')).toContain(String(taken))
  })

  test('opens the browser on the address and prints no address when it opened', async () => {
    const port = await freePort()
    const opened: string[] = []
    const logs: string[] = []
    const launch = await launchStudio(scratch(), ['--port', String(port)], {
      moduleUrl: fakeInstall(true).moduleUrl,
      openBrowser: async (url) => {
        opened.push(url)
        return true
      },
      log: (line) => logs.push(line),
      error: () => {}
    })
    if ('exitCode' in launch) throw new Error(`launch failed with exit ${launch.exitCode}`)
    closers.push(async () => {
      launch.child.kill()
      await launch.exited
    })
    expect(opened).toEqual([`http://127.0.0.1:${port}`])
    expect(logs.join('\n')).not.toContain(`127.0.0.1:${port}`)
  })

  test('a browser that cannot be opened does not fail the launch, and the address is printed once', async () => {
    for (const openBrowser of [async () => false, async () => Promise.reject(new Error('no opener'))]) {
      const port = await freePort()
      const logs: string[] = []
      const launch = await launchStudio(scratch(), ['--port', String(port)], {
        moduleUrl: fakeInstall(true).moduleUrl,
        openBrowser,
        log: (line) => logs.push(line),
        error: () => {}
      })
      if ('exitCode' in launch) throw new Error(`launch failed with exit ${launch.exitCode}`)
      closers.push(async () => {
        launch.child.kill()
        await launch.exited
      })
      const address = `http://127.0.0.1:${port}`
      expect(logs.join('\n').split(address).length - 1).toBe(1)
    }
  })
})

describe('studio bundle packing', () => {
  test('every node_modules folder is renamed for the packer and restored on first run', () => {
    const root = scratch()
    mkdirSync(join(root, 'node_modules', 'next', 'node_modules', 'dep'), { recursive: true })
    mkdirSync(studioServerDir(root), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'next', 'node_modules', 'dep', 'index.js'), 'x')
    packStudioNodeModules(root)
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
    expect(existsSync(join(root, STUDIO_NODE_MODULES_PACKED_DIRNAME, 'next', STUDIO_NODE_MODULES_PACKED_DIRNAME))).toBe(
      true
    )
    expect(repairStudioNodeModules(root)).toBe(true)
    expect(readFileSync(join(root, 'node_modules', 'next', 'node_modules', 'dep', 'index.js'), 'utf-8')).toBe('x')
    expect(repairStudioNodeModules(root)).toBe(false)
  })

  test('the server folder is two folders below the bundle root, derived from the app path', () => {
    expect(studioServerDir('/b')).toBe(join('/b', 'apps', 'vinaya-studio'))
  })
})
