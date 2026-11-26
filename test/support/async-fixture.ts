export function asyncFixture<Args extends unknown[], T>(
  fn: (...args: Args) => T,
): (...args: Args) => Promise<Awaited<T>> {
  return (...args) => {
    try {
      return Promise.resolve(fn(...args));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("Fixture failed", { cause: error }));
    }
  };
}
