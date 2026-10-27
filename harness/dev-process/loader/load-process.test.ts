import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProcess, ProcessLoadError, type ProcessLoadReason, processFields } from './load-process'

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
    [
      'schema-violation',
      'both flow and flows',
      'id: sample\nversion: v1\nflow: flow.yaml\nflows:\n  v1: flow.yaml\nroles: [roles/worker]\n',
      VALID_FILES,
      'flow'
    ],
    [
      'schema-violation',
      'a default_flow that names no declared flow',
      'id: sample\nversion: v1\nflows:\n  v1: flow.yaml\ndefault_flow: v9\nroles: [roles/worker]\n',
      VALID_FILES,
      'default_flow'
    ],
    [
      'declared-path-missing',
      'a declared flow file that does not exist',
      'id: sample\nversion: v1\nflows:\n  v1: flow.yaml\n  v2: missing.yaml\nroles: [roles/worker]\n',
      VALID_FILES,
      'flows.v2'
    ],
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

describe('two flows side by side', () => {
  const TWO =
    'id: sample\nversion: 1.0.0\nflows:\n  v1: flow.yaml\n  v2: flow-v2.yaml\ndefault_flow: v1\nroles:\n  - roles/worker\n'
  const TWO_FILES = { ...VALID_FILES, 'flow-v2.yaml': 'steps: [v2]\n' }

  test('a run that names no flow gets the default; naming one selects its file', () => {
    const folder = processFolder(TWO, TWO_FILES)
    const v1 = loadProcess(folder)
    expect(v1.flowKey).toBe('v1')
    expect(v1.flowPath).toBe(join(folder, 'flow.yaml'))
    const v2 = loadProcess(folder, { flow: 'v2' })
    expect(v2.flowKey).toBe('v2')
    expect(v2.flowPath).toBe(join(folder, 'flow-v2.yaml'))
    expect(Object.keys(v2.flowPaths).sort()).toEqual(['v1', 'v2'])
  })

  test('the digest pins every declared flow and does not depend on the one chosen', () => {
    const folder = processFolder(TWO, TWO_FILES)
    const first = loadProcess(folder).digest
    expect(loadProcess(folder, { flow: 'v2' }).digest).toBe(first)
    writeFileSync(join(folder, 'flow-v2.yaml'), 'steps: [changed]\n')
    expect(loadProcess(folder).digest).not.toBe(first)
  })

  test('without default_flow, v1 is the default, else the first key', () => {
    const withV1 = processFolder(TWO.replace('default_flow: v1\n', ''), TWO_FILES)
    expect(loadProcess(withV1).flowKey).toBe('v1')
    const noV1 = processFolder(
      'id: sample\nversion: 1.0.0\nflows:\n  alpha: flow.yaml\n  beta: flow-v2.yaml\nroles: [roles/worker]\n',
      TWO_FILES
    )
    expect(loadProcess(noV1).flowKey).toBe('alpha')
  })

  test('a single-flow process answers to the default key and refuses any other', () => {
    const folder = processFolder(VALID, VALID_FILES)
    expect(loadProcess(folder).flowKey).toBe('default')
    expect(() => loadProcess(folder, { flow: 'v2' })).toThrow(/flow "v2" is not declared/)
  })

  test('an undeclared flow key is refused as unknown-flow', () => {
    const folder = processFolder(TWO, TWO_FILES)
    try {
      loadProcess(folder, { flow: 'v3' })
      throw new Error('expected a refusal')
    } catch (error) {
      expect((error as ProcessLoadError).reason).toBe('unknown-flow')
    }
  })
})

describe('process contract', () => {
  test('the JSON schema and the validator require the same fields', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect([...schema.required].sort()).toEqual(['id', 'roles', 'version'])
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(processFields.shape).sort())
    const oneOf = (schema as unknown as { oneOf: Array<{ required: string[] }> }).oneOf
    expect(oneOf.map((branch) => branch.required)).toEqual([['flow'], ['flows']])
  })
})
