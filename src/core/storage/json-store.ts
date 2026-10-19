import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly createDefault: () => T,
  ) {}

  read(): T {
    if (!existsSync(this.filePath)) {
      return this.createDefault();
    }
    const raw = readFileSync(this.filePath, "utf8");
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new Error(`Cannot parse ${this.filePath}: ${(error as Error).message}`);
    }
  }

  write(value: T): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const temp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.filePath);
  }

  get path(): string {
    return this.filePath;
  }
}
