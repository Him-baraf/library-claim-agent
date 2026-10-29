import { promises as fs } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import archiver from "archiver";

/** Export references relative to the containing entry, so the evidence ZIP works offline. */
export function portableReferences(
  text: string,
  entryName: string,
  sweepId: string,
): string {
  const directory = path.posix.dirname(entryName);
  const root = path.posix.relative(directory, ".") || ".";
  return text.replaceAll(`/evidence/${sweepId}/`, `${root}/`);
}

export async function streamBundle(
  dir: string,
  id: string,
  dest: Writable,
): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new Error("Invalid sweep ID for evidence bundle.");
  const archive = archiver("zip", { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    dest.once("finish", resolve);
    dest.once("error", reject);
    archive.once("error", reject);
    archive.on("warning", reject);
    // A disconnected HTTP client must not leave file readers/compression running.
    dest.once("close", () => {
      if (!dest.writableFinished) {
        archive.abort();
        reject(new Error("Evidence download closed before completion."));
      }
    });
  });
  // Register an early rejection handler while the filesystem is being traversed.
  void done.catch(() => {});
  archive.pipe(dest);
  const add = async (relativeDir: string): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, relativeDir), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.endsWith(".tmp") || entry.isSymbolicLink()) continue;
      const diskRelative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await add(diskRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = diskRelative.split(path.sep).join("/");
      const full = path.join(dir, diskRelative);
      if (/\.(?:json|html?)$/i.test(entry.name)) {
        const original = await fs.readFile(full, "utf8");
        archive.append(portableReferences(original, name, id), { name });
      } else {
        // Frames/media remain file streams; never buffer the complete evidence set.
        archive.file(full, { name });
      }
    }
  };
  try {
    await add("");
    await archive.finalize();
    await done;
  } catch (error) {
    archive.abort();
    archive.unpipe(dest);
    throw error;
  }
}
