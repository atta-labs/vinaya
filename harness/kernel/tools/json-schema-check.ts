/** A compact Draft-7 validator for the subset emitted by z.toJSONSchema. */
export function validatesJsonSchema(schema: unknown, value: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return true
  const node = schema as Record<string, unknown>
  if (Array.isArray(node.anyOf)) return node.anyOf.some((variant) => validatesJsonSchema(variant, value))
  if ('const' in node && value !== node.const) return false
  if (Array.isArray(node.enum) && !node.enum.includes(value)) return false
  if (node.type === 'null') return value === null
  if (node.type === 'boolean') return typeof value === 'boolean'
  if (node.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const object = value as Record<string, unknown>
    const properties = (node.properties ?? {}) as Record<string, unknown>
    if (Array.isArray(node.required) && node.required.some((key) => typeof key !== 'string' || !(key in object)))
      return false
    if (node.additionalProperties === false && Object.keys(object).some((key) => !(key in properties))) return false
    return Object.entries(properties).every(
      ([key, property]) => !(key in object) || validatesJsonSchema(property, object[key])
    )
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) return false
    if (typeof node.minItems === 'number' && value.length < node.minItems) return false
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) return false
    return value.every((item) => validatesJsonSchema(node.items, item))
  }
  if (node.type === 'string') {
    if (typeof value !== 'string') return false
    return !(
      (typeof node.minLength === 'number' && value.length < node.minLength) ||
      (typeof node.maxLength === 'number' && value.length > node.maxLength)
    )
  }
  if (node.type === 'number' || node.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (node.type === 'integer' && !Number.isInteger(value)))
      return false
    return !(
      (typeof node.minimum === 'number' && value < node.minimum) ||
      (typeof node.maximum === 'number' && value > node.maximum)
    )
  }
  return true
}
