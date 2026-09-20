import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write `content` to `path` only when it differs from what is already there,
 * via a temp file and a rename so a reader never sees a half-written file.
 * Returns true when a write happened.
 */
export async function writeIfChanged(
  path: string,
  content: string,
): Promise<boolean> {
  try {
    if ((await readFile(path, "utf8")) === content) return false;
  } catch {
    // Missing or unreadable: fall through and write.
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
  return true;
}
