import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const safeRelativePath = (root: string, key: string) => {
  if (path.isAbsolute(key)) throw new Error("storage key must be relative");
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, key);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("storage key escapes document root");
  }
  return resolvedPath;
};

export class DocumentStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async put(key: string, contents: Buffer) {
    const target = safeRelativePath(this.root, key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${randomUUID()}`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, target);
  }

  read(key: string) {
    return readFile(safeRelativePath(this.root, key));
  }

  remove(key: string) {
    return rm(safeRelativePath(this.root, key), { force: true });
  }
}

export const sanitizeFilename = (value: string) => {
  const base = path.basename(value.replaceAll("\\", "/"));
  const sanitized = base.replace(/[\u0000-\u001f\u007f]/g, "_").trim();
  return (sanitized || "document.bin").slice(0, 180);
};
