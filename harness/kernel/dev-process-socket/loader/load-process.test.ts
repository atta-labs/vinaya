import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadProcess,
  ProcessLoadError,
  type ProcessLoadReason,
  processFields,
  providedRoleSchema,
  providesSchema
} from './load-process'

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
    // A process keeps its id when its folder is renamed: a renamed folder names the id it kept; any other folder's id
    // is its folder name.
    const keptIds: Record<string, string> = { 'vinaya-strict': 'vinaya' }
    for (const entry of folders) {
      const loaded = loadProcess(join(processesRoot, entry.name))
      expect(loaded.identity.id).toBe(keptIds[entry.name] ?? entry.name)
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

describe('provides', () => {
  const PROVIDES = [
    'provides:',
    '  roles:',
    '    worker:',
    '      doctrine: roles/worker/doctrine.md',
    '      grants: roles/worker/grants.yaml',
    '      output_schema: roles/worker/output.schema.json',
    '    helper:',
    '      doctrine: helper/doctrine.md',
    '      tools: helper/tools',
    '  checks: checks.ts',
    '  policies: policies.ts',
    '  config_section: config-section.ts',
    '  integration: integration.ts',
    ''
  ].join('\n')
  const DECLARED = `${VALID}${PROVIDES}`
  const DECLARED_FILES: Record<string, string> = {
    ...VALID_FILES,
    'roles/worker/doctrine.md': 'worker doctrine\n',
    'roles/worker/grants.yaml': 'tools: []\n',
    'roles/worker/output.schema.json': '{}\n',
    'helper/doctrine.md': 'helper doctrine\n',
    'helper/tools/tool.ts': 'export {}\n',
    'checks.ts': 'export {}\n',
    'policies.ts': 'export {}\n',
    'config-section.ts': 'export {}\n',
    'integration.ts': 'export {}\n'
  }

  test('a process that declares provides loads with every declared path resolved inside the folder', () => {
    const folder = processFolder(DECLARED, DECLARED_FILES)
    const loaded = loadProcess(folder)
    expect(loaded.provided).toEqual({
      roles: {
        worker: {
          doctrine: join(folder, 'roles/worker/doctrine.md'),
          grants: join(folder, 'roles/worker/grants.yaml'),
          outputSchema: join(folder, 'roles/worker/output.schema.json')
        },
        helper: { doctrine: join(folder, 'helper/doctrine.md'), tools: join(folder, 'helper/tools') }
      },
      checks: join(folder, 'checks.ts'),
      policies: join(folder, 'policies.ts'),
      configSection: join(folder, 'config-section.ts'),
      integration: join(folder, 'integration.ts')
    })
  })

  test('a process that declares no provides loads as before, with no provided parts and the same digest rules', () => {
    const folder = processFolder(VALID, VALID_FILES)
    const loaded = loadProcess(folder)
    expect(loaded.provided).toBeUndefined()
    expect(loaded.flowKey).toBe('default')
    // A file no declaration names stays out of the digest.
    writeFileSync(join(folder, 'checks.ts'), 'export {}\n')
    expect(loadProcess(folder).digest).toBe(loaded.digest)
  })

  test('the digest covers every declared file, a tools folder included', () => {
    const folder = processFolder(DECLARED, DECLARED_FILES)
    let previous = loadProcess(folder).digest
    for (const file of [
      'helper/doctrine.md',
      'helper/tools/tool.ts',
      'checks.ts',
      'policies.ts',
      'config-section.ts',
      'integration.ts'
    ]) {
      writeFileSync(join(folder, file), `changed ${file}\n`)
      const next = loadProcess(folder).digest
      expect(next).not.toBe(previous)
      previous = next
    }
  })

  const drop = (line: string) => DECLARED.replace(`${line}\n`, '')
  const provideRefusals: Array<[ProcessLoadReason, string, string, Record<string, string>, string]> = [
    ['schema-violation', 'provides with no checks', drop('  checks: checks.ts'), DECLARED_FILES, 'provides.checks'],
    [
      'schema-violation',
      'provides with no integration',
      drop('  integration: integration.ts'),
      DECLARED_FILES,
      'provides.integration'
    ],
    [
      'schema-violation',
      'a role with no doctrine',
      drop('      doctrine: helper/doctrine.md'),
      DECLARED_FILES,
      'provides.roles.helper.doctrine'
    ],
    [
      'launched-role-undeclared',
      'a launched role with no declaration',
      DECLARED.replace('    worker:\n', '    other:\n'),
      DECLARED_FILES,
      'provides.roles.worker'
    ],
    [
      'launched-role-undeclared',
      'a launched role with no grants',
      drop('      grants: roles/worker/grants.yaml'),
      DECLARED_FILES,
      'provides.roles.worker.grants'
    ],
    [
      'launched-role-undeclared',
      'a launched role with no output schema',
      drop('      output_schema: roles/worker/output.schema.json'),
      DECLARED_FILES,
      'provides.roles.worker.output_schema'
    ],
    [
      'declared-path-missing',
      'a declared doctrine that does not exist',
      DECLARED.replace('helper/doctrine.md', 'helper/missing.md'),
      DECLARED_FILES,
      'provides.roles.helper.doctrine'
    ],
    [
      'declared-path-missing',
      'a declared module that does not exist',
      DECLARED.replace('policies: policies.ts', 'policies: missing.ts'),
      DECLARED_FILES,
      'provides.policies'
    ],
    [
      'declared-path-escapes',
      'a declared module that leaves the folder',
      DECLARED.replace('config_section: config-section.ts', 'config_section: ../outside.ts'),
      DECLARED_FILES,
      'provides.config_section'
    ],
    [
      'declared-path-escapes',
      'an absolute tools folder',
      DECLARED.replace('tools: helper/tools', 'tools: /etc'),
      DECLARED_FILES,
      'provides.roles.helper.tools'
    ]
  ]

  for (const [reason, label, yaml, files, field] of provideRefusals) {
    test(`refuses ${label} as ${reason}, naming ${field}`, () => {
      const error = refusal(processFolder(yaml, files))
      expect(error.reason).toBe(reason)
      expect(error.field).toBe(field)
      expect(error.message).toContain(field)
    })
  }
})

describe('process contract', () => {
  test('the JSON schema and the validator declare the same provides parts', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties: {
        provides: {
          required: string[]
          properties: Record<string, { additionalProperties?: { required: string[]; properties: object } }>
        }
      }
    }
    const provides = schema.properties.provides
    expect(Object.keys(provides.properties).sort()).toEqual(Object.keys(providesSchema.shape).sort())
    expect([...provides.required].sort()).toEqual(
      Object.entries(providesSchema.shape)
        .filter(([, field]) => !field.isOptional())
        .map(([key]) => key)
        .sort()
    )
    const role = provides.properties.roles?.additionalProperties
    expect(Object.keys(role?.properties ?? {}).sort()).toEqual(Object.keys(providedRoleSchema.shape).sort())
    expect(role?.required).toEqual(['doctrine'])
  })

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
