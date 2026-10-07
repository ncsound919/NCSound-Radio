/**
 * Folder source (plan 4.2), via the File System Access API.
 *
 * `showDirectoryPicker()` returns a handle stored in IndexedDB. At boot the
 * permission is re-checked and, if it has lapsed, the tab says so rather than
 * silently dropping the folder. Chromium-only; Firefox/Safari report the tab as
 * unavailable.
 *
 * Files are enumerated, not stored: the handle re-reads them on demand, so a
 * 20 GB library costs one row of metadata per track.
 */
import type { LibraryTrack } from "../types";
import { makeId } from "../hash";
import { isAudioFile } from "./files";

export interface FsFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

export interface FsDirHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<FsFileHandle | FsDirHandle>;
}

type PickOptions = { id?: string; mode?: "read" | "readwrite" };

type PickerWindow = {
  showDirectoryPicker?: (opts?: PickOptions) => Promise<FsDirHandle>;
};

export function folderSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as PickerWindow).showDirectoryPicker === "function";
}

export async function pickFolder(): Promise<FsDirHandle> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("Folder import needs Chrome or Edge (File System Access API).");
  return picker({ id: "ncsound-library", mode: "read" });
}

type Permissible = {
  queryPermission?(d: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "read" }): Promise<PermissionState>;
};

/** True when the stored handle can still be read; asks again if the browser requires a gesture. */
export async function ensurePermission(dir: FsDirHandle): Promise<boolean> {
  const p = dir as unknown as Permissible;
  if (!p.queryPermission) return true;
  if ((await p.queryPermission({ mode: "read" })) === "granted") return true;
  if (!p.requestPermission) return false;
  return (await p.requestPermission({ mode: "read" })) === "granted";
}

export type FolderEntry = { path: string; handle: FsFileHandle };

async function walk(dir: FsDirHandle, prefix: string, out: FolderEntry[]): Promise<void> {
  for await (const entry of dir.values()) {
    if (entry.kind === "directory") {
      await walk(entry, `${prefix}${entry.name}/`, out);
    } else if (entry.kind === "file" && isAudioFile({ name: entry.name })) {
      out.push({ path: `${prefix}${entry.name}`, handle: entry });
    }
  }
}

export async function listFolderFiles(dir: FsDirHandle): Promise<FolderEntry[]> {
  const out: FolderEntry[] = [];
  await walk(dir, "", out);
  return out;
}

export async function readFolderFile(handle: FsFileHandle): Promise<File> {
  return handle.getFile();
}

/** Resolve a directory-relative path against a stored handle. */
export async function getFileByPath(dir: FsDirHandle, path: string): Promise<File> {
  const parts = path.split("/").filter(Boolean);
  let cur = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    let next: FsDirHandle | null = null;
    for await (const entry of cur.values()) {
      if (entry.kind === "directory" && entry.name === parts[i]) {
        next = entry;
        break;
      }
    }
    if (!next) throw new Error(`Folder no longer contains "${parts.slice(0, i + 1).join("/")}".`);
    cur = next;
  }
  const leaf = parts[parts.length - 1];
  for await (const entry of cur.values()) {
    if (entry.kind === "file" && entry.name === leaf) return entry.getFile();
  }
  throw new Error(`File not found: ${path}`);
}

export function folderTrack(handleId: string, path: string, file: File): LibraryTrack {
  const base = path.split("/").pop() ?? path;
  const title = base.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ");
  const artist = path.includes("/") ? path.split("/")[0] : "Unknown artist";
  return {
    id: makeId("folder", `${handleId}/${path}`),
    source: "folder",
    fileName: base,
    path,
    handleId,
    title,
    artist,
    size: file.size,
    lastModified: file.lastModified,
    durationSec: null,
    bpm: null,
    key: null,
    rating: 0,
    status: "unindexed",
    dateAddedMs: Date.now(),
  };
}
