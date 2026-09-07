import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Remove public access before reading existing application-owned files. */
export function hardenPrivateFile(file: string): number | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1)
    throw new Error("Refusing unsafe settings file");
  const mode = stat.mode & 0o600;
  if ((stat.mode & 0o7777) !== mode) fs.chmodSync(file, mode);
  return mode;
}

export function assertPrivateFileWritable(file: string): void {
  const mode = hardenPrivateFile(file);
  if (process.platform !== "win32" && mode !== undefined && mode !== 0o600) {
    throw new Error(
      "Settings file is owner read-only; refusing to broaden permissions"
    );
  }
}

/** No plaintext fallback, no permissive temporary files, no symlink following. */
export function writePrivateFile(
  file: string,
  bytes: string | Buffer,
  verify?: (bytes: Buffer) => void
): void {
  assertPrivateFileWritable(file);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    verify?.(fs.readFileSync(temp));
    assertPrivateFileWritable(file);
    fs.renameSync(temp, file);
    if (process.platform !== "win32") {
      const directory = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
