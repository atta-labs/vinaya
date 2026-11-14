// Read by the recorder's source scan, never run: Bun's resolve functions and `bun:ffi`, which the listing probe wraps.
export const where = (dir: string): string => Bun.resolveSync('./widget', dir)

export const native = async (path: string): Promise<unknown> => (await import('bun:ffi')).dlopen(path, {})
