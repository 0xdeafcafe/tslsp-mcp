import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient } from "./lsp-client.js";

/** Walk up from `start` looking for the nearest tsconfig.json. */
export function findProjectRoot(start: string): string | undefined {
  let dir = isAbsolute(start) ? start : resolve(start);
  try {
    if (statSync(dir).isFile()) dir = dirname(dir);
  } catch {
    // Path may not exist yet — fall back to its parent dir.
    dir = dirname(dir);
  }
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Find the tsgo executable. The published `@typescript/native-preview` package
 * installs as `bin/tsgo.js` (a Node shim that locates the platform binary) and
 * gets symlinked into `node_modules/.bin/tsgo`. Prefer the workspace's local
 * install (so the user's pinned tsgo version wins), then fall back to ours.
 * Avoid PATH lookup — a stale homebrew-installed tsgo there can shadow the
 * pinned one with subtly different LSP behavior.
 */
export function resolveTsgoBin(rootPath: string): string {
  for (const candidate of walkUpCandidates(rootPath)) {
    if (existsSync(candidate)) return candidate;
  }
  const here = fileURLToPath(new URL(".", import.meta.url));
  const bundled = join(here, "..", "node_modules", "@typescript", "native-preview", "bin", "tsgo.js");
  if (existsSync(bundled)) return bundled;
  throw new Error(
    `Could not find tsgo. Install @typescript/native-preview in your workspace or in tslsp-mcp's deps.`,
  );
}

function* walkUpCandidates(start: string): Generator<string> {
  let dir = start;
  for (;;) {
    yield join(dir, "node_modules", "@typescript", "native-preview", "bin", "tsgo.js");
    yield join(dir, "node_modules", ".bin", "tsgo");
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export class LspPool {
  private clients = new Map<string, LspClient>();

  constructor(private log?: (line: string) => void) {}

  /** Resolve a file path to its LSP client, spawning one if needed. */
  async forFile(filePath: string): Promise<{ client: LspClient; root: string }> {
    const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
    const root = findProjectRoot(abs);
    if (!root) {
      throw new Error(
        `no tsconfig.json found walking up from ${abs}. tslsp-mcp routes by tsconfig root.`,
      );
    }
    let client = this.clients.get(root);
    if (!client) {
      const bin = resolveTsgoBin(root);
      client = new LspClient({ binPath: bin, rootPath: root, log: this.log });
      this.clients.set(root, client);
    }
    await client.ready();
    await client.ensureProjectSeeded();
    return { client, root };
  }

  /** Resolve by an explicit project root (used for workspace/symbol with no file hint). */
  async forRoot(rootPath: string): Promise<LspClient> {
    let client = this.clients.get(rootPath);
    if (!client) {
      const bin = resolveTsgoBin(rootPath);
      client = new LspClient({ binPath: bin, rootPath, log: this.log });
      this.clients.set(rootPath, client);
    }
    await client.ready();
    await client.ensureProjectSeeded();
    return client;
  }

  roots(): string[] {
    return [...this.clients.keys()];
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.dispose()));
    this.clients.clear();
  }
}
