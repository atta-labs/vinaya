import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProcess, ProcessLoadError, type ProcessLoadReason, processSchema } from './load-process'

const processesRoot = join(import.meta.dir, '..', '..', '..', 'processes')
const schemaPath = join(import.meta.dir, '..', 'contract', 'process.schema.json')

const made: string[] = []
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function processFolder(processYaml: string | null, files: Record<string, string> = {}): string {
  const folder = mkdtempSync(join(tmpdir(), 'process-'))
  made.push(folder)
  if (processYaml !== null) writeFileSync(join(folder, 'process.yaml'), processYaml)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(folder, name, '..'), { recursive: true })
    writeFileSync(join(folder, name), content)
  }
  return folder
}

const VALID = 'id: sample\nversion: 1.0.0\nflow: flow.yaml\nroles:\n  - roles/worker\n'
const VALID_FILES = { 'flow.yaml': 'steps: []\n', 'roles/worker/role.md': 'worker\n' }

function refusal(folder: string): ProcessLoadError {
  try {
    loadProcess(folder)
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessLoadError)
    return error as ProcessLoadError
  }
  throw new Error('expected loadProcess to refuse')
}

describe('loadProcess', () => {
  test('loads every real process folder', () => {
    const folders = readdirSync(processesRoot, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && readdirSync(join(processesRoot, entry.name)).includes('process.yaml')
    )
    expect(folders.length).toBeGreaterThan(0)
    for (const entry of folders) {
      const loaded = loadProcess(join(processesRoot, entry.name))
      expect(loaded.identity.id).toBe(entry.name)
      expect(loaded.rolePaths).toHaveLength(loaded.identity.roles.length)
      expect(loaded.digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('digest is stable across two loads and changes with any declared file', () => {
    const folder = processFolder(VALID, VALID_FILES)
    const first = loadProcess(folder).digest
    expect(loadProcess(folder).digest).toBe(first)

    writeFileSync(join(folder, 'roles/worker/role.md'), 'changed\n')
    const afterRole = loadProcess(folder).digest
    expect(afterRole).not.toBe(first)

    writeFileSync(join(folder, 'flow.yaml'), 'steps: [x]\n')
    const afterFlow = loadProcess(folder).digest
    expect(afterFlow).not.toBe(afterRole)

    writeFileSync(join(folder, 'process.yaml'), VALID.replace('1.0.0', '1.0.1'))
    expect(loadProcess(folder).digest).not.toBe(afterFlow)
  })

  const refusals: Array<[ProcessLoadReason, string, string | null, Record<string, string>, string?]> = [
    ['missing-process-file', 'no process.yaml', null, {}],
    ['unparseable-yaml', 'YAML that does not parse', 'id: [unclosed\n', {}],
    ['schema-violation', 'a required field absent', 'id: sample\nversion: v1\nroles: [a]\n', {}, 'flow'],
    ['schema-violation', 'a field of the wrong type', 'id: sample\nversion: v1\nflow: f\nroles: nope\n', {}, 'roles'],
    ['declared-path-missing', 'a declared path that does not exist', VALID, { 'flow.yaml': 'x' }],
    [
      'declared-path-escapes',
      'a declared path that leaves the folder',
      VALID.replace('flow.yaml', '../outside.yaml'),
      VALID_FILES
    ],
    ['declared-path-escapes', 'an absolute declared path', VALID.replace('flow.yaml', '/etc/hosts'), VALID_FILES]
  ]

  for (const [reason, label, yaml, files, field] of refusals) {
    test(`refuses ${label} as ${reason}`, () => {
      const error = refusal(processFolder(yaml, files))
      expect(error.reason).toBe(reason)
      if (field) {
        expect(error.field).toBe(field)
        expect(error.message).toContain(field)
      }
    })
  }
})

describe('process contract', () => {
  test('the JSON schema and the validator require the same fields', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect([...schema.required].sort()).toEqual(['flow', 'id', 'roles', 'version'])
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(processSchema.shape).sort())
  })
})
