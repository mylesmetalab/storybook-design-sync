import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative } from "node:path";
import { glob } from "tinyglobby";

/**
 * Guard against raw control bytes in source files.
 *
 * A literal NUL byte (rather than the `\0` escape) shipped in
 * `server.ts`'s engine-memo key separator. It was valid JavaScript and
 * behaved correctly, so nothing caught it — but it made the file *binary*
 * to line-oriented tooling: `grep -r` silently skipped every match in it
 * (reporting "Binary file matches" at best, nothing at worst) and
 * `git diff` rendered "Binary files differ" instead of a patch.
 *
 * Silently unsearchable, undiffable source is the actual damage here, so
 * this asserts the property directly rather than pinning the one call site.
 * Escapes (`"\0"`, two characters) are fine; raw bytes are not.
 */
const SRC = dirname(fileURLToPath(import.meta.url));

// Tab (0x09), LF (0x0a) and CR (0x0d) are legitimate in source text.
// Everything else below 0x20, plus DEL (0x7f), is not.
function controlByteOffsets(buf: Buffer): number[] {
  const hits: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    const allowed = c === 0x09 || c === 0x0a || c === 0x0d;
    if ((c < 0x20 && !allowed) || c === 0x7f) hits.push(i);
  }
  return hits;
}

describe("source hygiene", () => {
  it("no source file contains raw control bytes", async () => {
    const files = await glob(["**/*.ts", "**/*.tsx"], {
      cwd: SRC,
      absolute: true,
      onlyFiles: true,
    });
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const buf = await readFile(file);
      const hits = controlByteOffsets(buf);
      if (hits.length === 0) continue;
      const where = hits
        .slice(0, 5)
        .map((i) => `offset ${i} (0x${buf[i]!.toString(16).padStart(2, "0")})`)
        .join(", ");
      offenders.push(
        `${relative(SRC, file)}: ${hits.length} control byte(s) — ${where}. ` +
          `Use an escape sequence (e.g. "\\0") instead of a literal byte.`,
      );
    }

    expect(offenders).toEqual([]);
  });
});
