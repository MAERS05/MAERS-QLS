/** Existing API views use explicit descriptors, without inheritance or copied mutable state. */
export function composeCapabilities(...sources) {
  const facade = {}
  for (const source of sources) {
    for (const key of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key)
      Object.defineProperty(facade, key, {
        enumerable: true,
        configurable: true,
        get: () => source[key],
        ...(descriptor.writable || descriptor.set ? { set: value => { source[key] = value } } : {}),
      })
    }
  }
  return facade
}
