import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

export interface Cycle {
  name: string;
  open: boolean;
  queries: number;
  writes: number;
  unknown: number;
}
export interface ScopeObserver {
  cycle(name: string): Cycle | undefined;
  finish(cycle: Cycle, elapsedMs: number): void;
}
export const observers = new Map<string, ScopeObserver>();
export const context = new AsyncLocalStorage<{
  observer: ScopeObserver;
  cycle: Cycle;
}>();

// Disabled captures avoid timers and async context allocation on scheduler hot paths.
export function performanceScope<T>(directory: string, name: string, work: () => Promise<T>): Promise<T>;
export function performanceScope<T>(directory: string, name: string, work: () => T): T;
export function performanceScope(directory: string, name: string, work: () => unknown): unknown {
  const observer = observers.get(resolve(directory));
  if (!observer) return work();
  const cycle = observer.cycle(name);
  if (!cycle) return work();
  const start = performance.now();
  const finish = () => {
    cycle.open = false;
    observer.finish(cycle, performance.now() - start);
  };
  return context.run({ observer, cycle }, () => {
    try {
      const result = work();
      if (result instanceof Promise) return result.finally(finish);
      finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  });
}
