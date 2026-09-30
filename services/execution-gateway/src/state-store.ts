import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Crash-safe JSON persistence (write temp + atomic rename). Open trades, stop order ids and
 * daily counters survive restarts; on start the engine re-verifies everything against the broker.
 */
export class StateStore<T> {
  constructor(private readonly file: string | null) {}

  load(): T | null {
    if (!this.file) return null;
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  save(state: T): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.file);
  }
}
