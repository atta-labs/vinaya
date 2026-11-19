import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '../src/index.js'

function setup() {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-rotation-'))
  const options = { runtimeDir, repoRoot: join(runtimeDir, 'repo'), runId: 'run', repository: 'acme/widgets' }
  return { options, folder: join(runtimeDir, 'logs', 'acme-widgets') }
}

type StageRecord = {
  resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string; value: { stringValue: string } }[] }[] }[] }[]
}

function records(folder: string, files: string[]) {
  return files.flatMap((file) =>
    readFileSync(join(folder, file), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => {
        const doc = JSON.parse(line) as StageRecord
        const attrs = doc.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes ?? []
        return {
          writer: attrs.find((attr) => attr.key === 'vinaya.writer.id')?.value.stringValue,
          stage: attrs.find((attr) => attr.key === 'vinaya.stage.to')?.value.stringValue
        }
      })
  )
}

test('a failed partial append is reported and seals the segment', async () => {
  const { options, folder } = setup()
  const errors: unknown[] = []
  try {
    const handle = connect({ ...options, onError: (error) => errors.push(error) })
    handle.run.stageChanged({ to: 'first' })
    const file = readdirSync(folder)[0]!
    const path = join(folder, file)
    const original = readFileSync(path)
    const write = fs.writeSync
    const append = spyOn(fs, 'writeSync')
      .mockImplementationOnce((fd, buffer) => write(fd, buffer as Uint8Array, 0, 17))
      .mockImplementationOnce(() => {
        throw new Error('simulated disk full')
      })
    let partial: Buffer
    try {
      expect(() => handle.run.stageChanged({ to: 'second' })).not.toThrow()
      expect(errors).toEqual([expect.objectContaining({ message: 'simulated disk full' })])
      partial = readFileSync(path)
      expect(partial.length).toBe(original.length + 17)
      expect(partial.subarray(0, original.length).equals(original)).toBe(true)
      expect(() => JSON.parse(partial.subarray(original.length).toString())).toThrow()
    } finally {
      append.mockRestore()
    }
    await handle.flush()
    expect(readFileSync(path).equals(partial)).toBe(true)
    handle.run.stageChanged({ to: 'third' })
    await handle.shutdown()
    const files = readdirSync(folder).sort()
    expect(files).toHaveLength(2)
    expect(files[0]).toBe(file)
    expect(readFileSync(path).equals(partial)).toBe(true)
    expect(records(folder, files.slice(1))).toEqual([{ stage: 'third', writer: handle.writerId }])
    const next = JSON.parse(readFileSync(join(folder, files[1]!), 'utf8'))
    const sequence = next.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find(
      (attr: { key: string }) => attr.key === 'vinaya.seq'
    )
    expect(Number(sequence?.value.intValue)).toBe(3)
    expect(errors).toHaveLength(1)
  } finally {
    rmSync(options.runtimeDir, { recursive: true, force: true })
  }
})

test('three size rollovers preserve each record and seal earlier files', () => {
  const { options, folder } = setup()
  const errors: unknown[] = []
  const payload = 'é'.repeat((3 * 1024 * 1024) / 2)
  try {
    const handle = connect({ ...options, onError: (error) => errors.push(error) })
    const stages = Array.from({ length: 8 }, (_, i) => `${i} ${payload}`)
    const sealed = new Map<string, Buffer>()
    for (const stage of stages) {
      handle.run.stageChanged({ to: stage })
      const files = readdirSync(folder).sort()
      for (const file of files.slice(0, -1)) {
        if (!sealed.has(file)) sealed.set(file, readFileSync(join(folder, file)))
      }
    }
    const files = readdirSync(folder).sort()
    expect(files).toHaveLength(4)
    for (const [file, original] of sealed) expect(readFileSync(join(folder, file)).equals(original)).toBe(true)
    expect(records(folder, files)).toEqual(stages.map((stage) => ({ stage, writer: handle.writerId })))
    expect(errors).toEqual([])
  } finally {
    rmSync(options.runtimeDir, { recursive: true, force: true })
  }
})

test('writers in the same process and in child processes keep independent files', async () => {
  const { options, folder } = setup()
  try {
    const moduleUrl = new URL('../src/index.ts', import.meta.url).href
    const children = ['child-a', 'child-b'].map((label) =>
      Bun.spawn(
        [
          process.execPath,
          '--eval',
          `import { connect } from ${JSON.stringify(moduleUrl)}
       const handle = connect(${JSON.stringify(options)})
       for (let i = 0; i < 10; i++) handle.run.stageChanged({ to: ${JSON.stringify(label)} + '-' + i })
       console.log(handle.writerId)`
        ],
        { stdout: 'pipe', stderr: 'inherit' }
      )
    )
    const expected = new Map<string, string[]>()
    const first = connect(options)
    const second = connect(options)
    for (let i = 0; i < 10; i++) {
      first.run.stageChanged({ to: `parent-a-${i}` })
      second.run.stageChanged({ to: `parent-b-${i}` })
    }
    const childIds = await Promise.all(
      children.map(async (child) => {
        const id = (await new Response(child.stdout).text()).trim()
        expect(await child.exited).toBe(0)
        return id
      })
    )
    for (const [id, label] of [
      [first.writerId, 'parent-a'],
      [second.writerId, 'parent-b'],
      [childIds[0]!, 'child-a'],
      [childIds[1]!, 'child-b']
    ] as const) {
      expected.set(
        id,
        Array.from({ length: 10 }, (_, i) => `${label}-${i}`)
      )
    }
    const files = readdirSync(folder)
    expect(files).toHaveLength(4)
    expect(expected.size).toBe(4)
    for (const file of files) {
      const writer = file.split('~')[1]!
      const stages = expected.get(writer)
      if (!stages) throw new Error(`Unexpected writer in ${file}`)
      expect(records(folder, [file])).toEqual(stages.map((stage) => ({ stage, writer })))
      expected.delete(writer)
    }
    expect(expected.size).toBe(0)
  } finally {
    rmSync(options.runtimeDir, { recursive: true, force: true })
  }
})

test('a replaced active file and a non-regular new target are refused', () => {
  const { options, folder } = setup()
  const errors: unknown[] = []
  const onError = (error: unknown) => errors.push(error)
  try {
    const handle = connect({ ...options, onError })
    handle.run.alive()
    const path = join(folder, readdirSync(folder)[0]!)
    const victim = join(options.runtimeDir, 'victim')
    writeFileSync(victim, 'keep')
    renameSync(path, join(options.runtimeDir, 'saved'))
    symlinkSync(victim, path)
    expect(() => handle.run.alive()).not.toThrow()
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(errors).toHaveLength(1)

    const second = connect({ ...options, onError })
    mkdirSync(join(folder, `run~${second.writerId}~000000000000.logs.jsonl`))
    expect(() => second.run.alive()).not.toThrow()
    expect(errors).toHaveLength(2)
  } finally {
    rmSync(options.runtimeDir, { recursive: true, force: true })
  }
})
