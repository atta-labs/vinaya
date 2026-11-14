// Mentions Bun's resolve functions and `bun:ffi` without calling them: a module loaded only for its value.
export const where = (dir: string): string => Bun.resolveSync('./target/mod', dir)

export const native = async (path: string): Promise<unknown> => (await import('bun:ffi')).dlopen(path, {})

export const value = 'mentions'
