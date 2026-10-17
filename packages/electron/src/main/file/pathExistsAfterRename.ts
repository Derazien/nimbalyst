import { access } from "fs/promises";
import { runWithFsLimit } from "./WatchedFileReader";

/** An atomic replacement can briefly remove the destination. Never classify I/O errors as deletion. */
export async function pathExistsAfterRename(
  filePath: string
): Promise<boolean> {
  for (const delay of [0, 25, 100]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      // One probe per rename event is unbounded during a checkout; share the watcher fs limit.
      await runWithFsLimit(() => access(filePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}
