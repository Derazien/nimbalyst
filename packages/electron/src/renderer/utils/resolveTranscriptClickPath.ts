/**
 * Resolve a file path emitted in the AI transcript to an absolute path.
 *
 * Autolinked bare file paths (and some markdown links) are workspace-relative,
 * but the main-process file opener (`openFile` in FileOpener.ts) requires an
 * absolute path — it `existsSync`-checks the literal string and does NOT join
 * against the workspace, so a relative path silently opens a blank tab. Join
 * relative paths against the session's working directory (the worktree path for
 * worktree sessions, otherwise the workspace path). Absolute paths (POSIX `/`,
 * Windows `C:\` / `C:/`, or UNC `\\`) are returned unchanged.
 */
export function resolveTranscriptClickPath(filePath: string, baseDir?: string): string {
  const isAbsolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(filePath);
  if (isAbsolute || !baseDir) return filePath;
  const trimmedBase = baseDir.replace(/[\\/]+$/, '');
  return `${trimmedBase}/${filePath}`;
}

/**
 * The directory a transcript's relative paths are relative to.
 *
 * The session's worktree if it has one, else the session's own project, else the window's.
 * The window's project used to be the only fallback, which is wrong for a session that lives
 * elsewhere: its agent writes paths relative to its own checkout, and joining them onto this
 * project's root names a file that does not exist.
 */
export function transcriptClickBase(args: {
  sessionWorktreePath?: string | null;
  sessionWorkspacePath?: string | null;
  windowWorkspacePath: string;
}): string {
  const worktree = args.sessionWorktreePath?.trim();
  if (worktree) return worktree;
  const own = args.sessionWorkspacePath?.trim();
  if (own) return own;
  return args.windowWorkspacePath;
}
