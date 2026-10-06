import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  refreshStagedCodexLogin,
  reuseStagedCodexHome,
  stageCodexPolicyHome
} from '../../../src/lib/worker-boundary.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'codex-login-refresh-'))
  roots.push(root)
  const realHome = join(root, 'home')
  mkdirSync(join(realHome, '.codex'), { recursive: true })
  const operatorAuth = join(realHome, '.codex', 'auth.json')
  writeFileSync(operatorAuth, 'login-one')
  const stage = (name: string) =>
    stageCodexPolicyHome({
      targetDir: join(root, name),
      realHome,
      execpolicyRules: '',
      sandboxConfigToml: ''
    })?.codexHome as string
  return { realHome, operatorAuth, stage }
}

const touch = (path: string, secondsFromNow: number) => {
  const t = new Date(Date.now() + secondsFromNow * 1000)
  utimesSync(path, t, t)
}

describe('refreshStagedCodexLogin', () => {
  it('replaces the copy when the operator login is newer', () => {
    const { realHome, operatorAuth, stage } = setup()
    const home = stage('a')
    writeFileSync(operatorAuth, 'login-two')
    touch(operatorAuth, 60)
    expect(refreshStagedCodexLogin({ realHome, codexHome: home })).toBe(true)
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('login-two')
  })

  it('keeps the copy when the operator login is not newer', () => {
    const { realHome, operatorAuth, stage } = setup()
    const home = stage('a')
    writeFileSync(operatorAuth, 'login-two')
    touch(operatorAuth, -60)
    expect(refreshStagedCodexLogin({ realHome, codexHome: home })).toBe(false)
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('login-one')
  })

  it('shares no file between homes and never writes back to the operator', () => {
    const { realHome, operatorAuth, stage } = setup()
    const a = stage('a')
    const b = stage('b')
    writeFileSync(operatorAuth, 'login-two')
    touch(operatorAuth, 60)
    refreshStagedCodexLogin({ realHome, codexHome: a })
    const inodes = [operatorAuth, join(a, 'auth.json'), join(b, 'auth.json')].map((p) => statSync(p).ino)
    expect(new Set(inodes).size).toBe(3)
    writeFileSync(join(a, 'auth.json'), 'refreshed-by-codex')
    expect(readFileSync(operatorAuth, 'utf8')).toBe('login-two')
    expect(readFileSync(join(b, 'auth.json'), 'utf8')).toBe('login-one')
  })

  it('leaves no temp sibling when the replace fails', () => {
    const { realHome, operatorAuth, stage } = setup()
    const home = stage('a')
    // A directory where the login sits makes the final rename fail after the temp write.
    rmSync(join(home, 'auth.json'))
    mkdirSync(join(home, 'auth.json'))
    touch(join(home, 'auth.json'), -120)
    touch(operatorAuth, 60)
    expect(refreshStagedCodexLogin({ realHome, codexHome: home })).toBe(false)
    expect(readdirSync(home).filter((e) => e.includes('.refresh-'))).toEqual([])
  })
})

describe('reuseStagedCodexHome', () => {
  it('reuses a staged home and refreshes its login from a newer operator login', () => {
    const { realHome, operatorAuth, stage } = setup()
    const home = stage('a')
    writeFileSync(operatorAuth, 'login-two')
    touch(operatorAuth, 60)
    expect(reuseStagedCodexHome({ realHome, codexHome: home })).toBe(home)
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('login-two')
  })

  it('returns null for a home with no staged login', () => {
    const { realHome } = setup()
    const empty = join(realHome, 'nothing')
    expect(reuseStagedCodexHome({ realHome, codexHome: empty })).toBeNull()
    expect(existsSync(empty)).toBe(false)
  })
})
