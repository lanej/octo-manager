import { lstatSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { loadRepositoryConfig } from "./config.js";

type Configuration = ReturnType<typeof loadRepositoryConfig> | Error;
interface Root {
  value?: Configuration;
  watchers: FSWatcher[];
}

// Directory watches survive atomic config replacement; the parent watch detects root replacement.
export class RepositoryPolicyMonitor {
  private roots = new Map<string, Root>();
  private changed: (() => void) | undefined;
  constructor(private load = loadRepositoryConfig) {}

  start(changed: () => void): void {
    this.invalidate();
    this.changed = changed;
  }
  read(path: string): Configuration {
    let root = this.roots.get(path);
    if (root === undefined) {
      root = { watchers: [] };
      this.roots.set(path, root);
    }
    if (root.value !== undefined) return root.value;
    try {
      if (realpathSync(path) !== path)
        throw new Error("Repository root changed");
      if (this.changed !== undefined && root.watchers.length === 0) {
        const identity = lstatSync(path);
        const invalidated = () => {
          this.invalidate(path);
          this.changed?.();
        };
        const directory = watch(path, (_event, filename) => {
          if (
            filename === null ||
            ["octo-manager.toml", ".source-code.json", basename(path)].includes(
              String(filename),
            )
          )
            invalidated();
        });
        root.watchers.push(directory);
        directory.on("error", invalidated);
        const parent = watch(dirname(path), (_event, filename) => {
          if (filename !== null && String(filename) !== basename(path)) return;
          try {
            const current = lstatSync(path);
            if (
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
        parent.on("error", invalidated);
      }
      root.value = this.load(path);
    } catch (error) {
      this.invalidate(path);
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
      delete root.value;
    }
  }
  retain(paths: Set<string>): void {
    for (const [path, root] of this.roots) {
      if (paths.has(path)) continue;
      for (const watcher of root.watchers) watcher.close();
      this.roots.delete(path);
    }
  }
  retryNeeded(): boolean {
    return (
      this.changed !== undefined &&
      [...this.roots.values()].some((root) => root.watchers.length === 0)
    );
  }
  close(): void {
    this.changed = undefined;
    this.invalidate();
    this.roots.clear();
  }
}
