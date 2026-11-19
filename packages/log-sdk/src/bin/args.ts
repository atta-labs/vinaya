export type Fields = Record<string, unknown>

type FieldsResult = { ok: true; name: string; fields: Fields } | { ok: false; message?: string }

export async function readFields(args: readonly string[], readStdin: () => Promise<string>): Promise<FieldsResult> {
  const name = args[0]
  if (!name || name.startsWith('-')) return { ok: false }
  const flag = args.indexOf('--json')
  const raw = flag === -1 ? await readStdin() : args[flag + 1]
  if (raw === undefined) return { ok: false }
  let fields: unknown
  try {
    fields = JSON.parse(raw)
  } catch {
    return { ok: false, message: 'the JSON could not be read.' }
  }
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    return { ok: false, message: 'the field values must be a JSON object.' }
  }
  return { ok: true, name, fields: fields as Fields }
}

export function takeOption(args: string[], option: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') {
      i++
    } else if (args[i] === option) {
      return args.splice(i, 2)[1]
    }
  }
  return undefined
}
