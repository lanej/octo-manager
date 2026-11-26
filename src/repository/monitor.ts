import {
  lstatSync,
  realpathSync,
  watch,
  type FSWatcher,
  type Stats,
} from "node:fs";
import { basename, dirname } from "node:path";
import { loadRepositoryConfig } from "./config.js";

type Configuration = ReturnType<typeof loadRepositoryConfig> | Error;
interface Root {
  value?: Configuration;
  watchers: FSWatcher[];
  failed: boolean;
  generation: number;
}
type Observe = (
  path: string,
  listener: (event: string, filename: string | null) => void,
) => FSWatcher;

// Directory watches survive atomic config replacement; the parent watch detects root replacement.
export class RepositoryPolicyMonitor {
  private roots = new Map<string, Root>();
  private changed: (() => void) | undefined;
  constructor(
    private load = loadRepositoryConfig,
    private observe: Observe = watch,
  ) {}

  start(changed: () => void): void {
    this.invalidate();
    this.changed = changed;
  }
  read(path: string): Configuration {
    let root = this.roots.get(path);
    if (root === undefined) {
      root = { watchers: [], failed: false, generation: 0 };
      this.roots.set(path, root);
    }
    if (root.value !== undefined) return root.value;
    try {
      if (this.changed !== undefined && root.watchers.length === 0) {
        const generation = root.generation;
        const invalidated = () => {
          if (root.generation !== generation) return;
          this.invalidate(path);
          this.changed?.();
        };
        const unavailable = (error: Error) => {
          if (root.generation !== generation) return;
          this.invalidate(path);
          root.failed = true;
          root.value = error;
          this.changed?.();
        };
        try {
          let identity: Stats | undefined;
          const parent = this.observe(dirname(path), (_event, filename) => {
            if (filename !== null && filename !== basename(path)) return;
            try {
              const current = lstatSync(path);
              if (
                identity !== undefined &&
                current.ino === identity.ino &&
                current.dev === identity.dev &&
                !current.isSymbolicLink()
              )
                return;
            } catch {
              // Losing the bound root revokes retained policy until a successful read.
            }
            invalidated();
          });
          root.watchers.push(parent);
          parent.on("error", unavailable);
          try {
            identity = lstatSync(path);
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
          }
          // An absent checkout is stable while its parent can notify us of recreation.
          if (identity?.isDirectory() === true && realpathSync(path) === path) {
            const directory = this.observe(path, (_event, filename) => {
              if (
                filename === null ||
                [
                  "octo-manager.toml",
                  ".source-code.json",
                  basename(path),
                ].includes(filename)
              )
                invalidated();
            });
            root.watchers.push(directory);
            directory.on("error", unavailable);
          }
        } catch (error) {
          this.invalidate(path);
          root.failed = true;
          throw error;
        }
      }
      if (realpathSync(path) !== path)
        throw new Error("Repository root changed");
      root.value = this.load(path);
    } catch (error) {
      root.value =
        error instanceof Error
          ? error
          : new Error("Repository policy unavailable");
    }
    return root.value;
  }
  invalidate(path?: string): void {
    for (const [key, root] of this.roots) {
      if (path !== undefined && key !== path) continue;
      for (const watcher of root.watchers) watcher.close();
      root.watchers = [];
      root.failed = false;
      root.generation++;
      delete root.value;
    }
  }
  retain(paths: Set<string>): void {
    for (const [path, root] of this.roots) {
      if (paths.has(path)) continue;
      root.generation++;
      for (const watcher of root.watchers) watcher.close();
      this.roots.delete(path);
    }
  }
  retryNeeded(): boolean {
    return (
      this.changed !== undefined &&
      [...this.roots.values()].some((root) => root.failed)
    );
  }
  retryUnavailable(): void {
    for (const [path, root] of this.roots)
      if (root.failed) this.invalidate(path);
  }
  close(): void {
    this.changed = undefined;
    this.invalidate();
    this.roots.clear();
  }
}
