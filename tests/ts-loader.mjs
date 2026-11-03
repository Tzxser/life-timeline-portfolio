// Keep the test imports TypeScript-friendly (extensionless for `tsc`) while
// allowing Node's built-in test runner to resolve the source files directly.
// Node 24 strips types at load time; this tiny resolver only fills in the
// source extension that a normal ESM build would add.
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs']

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const projectRelative = specifier.slice(2)
    for (const extension of SOURCE_EXTENSIONS) {
      try {
        const target = new URL(`../${projectRelative}${extension}`, import.meta.url)
        return await nextResolve(target.href, context)
      } catch {
        // Try the next source extension.
      }
    }
    for (const extension of SOURCE_EXTENSIONS) {
      try {
        const target = new URL(`../${projectRelative}/index${extension}`, import.meta.url)
        return await nextResolve(target.href, context)
      } catch {
        // Try a directory index when the alias names a folder.
      }
    }
  }

  const barePath = specifier.split(/[?#]/, 1)[0]
  const isRelative = barePath.startsWith('./') || barePath.startsWith('../')
  const hasExtension = /\.[a-z0-9]+$/i.test(barePath)

  if (isRelative && !hasExtension) {
    for (const extension of SOURCE_EXTENSIONS) {
      try {
        return await nextResolve(`${specifier}${extension}`, context)
      } catch {
        // Try the next source extension.
      }
    }
    for (const extension of SOURCE_EXTENSIONS) {
      try {
        return await nextResolve(`${specifier}/index${extension}`, context)
      } catch {
        // Directory imports need the same explicit extension probing.
      }
    }
  }

  return nextResolve(specifier, context)
}
