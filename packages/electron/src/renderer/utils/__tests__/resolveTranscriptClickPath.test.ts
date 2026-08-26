// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveTranscriptClickPath } from '../resolveTranscriptClickPath';

describe('resolveTranscriptClickPath', () => {
  const base = '/Users/me/project';

  it('joins a workspace-relative path against the base dir', () => {
    expect(resolveTranscriptClickPath('nimbalyst-local/plans/foo.md', base)).toBe(
      '/Users/me/project/nimbalyst-local/plans/foo.md',
    );
  });

  it('resolves against the worktree path when that is the base', () => {
    expect(
      resolveTranscriptClickPath('src/a/foo.ts', '/Users/me/project_worktrees/jade-spark'),
    ).toBe('/Users/me/project_worktrees/jade-spark/src/a/foo.ts');
  });

  it('leaves POSIX absolute paths unchanged', () => {
    expect(resolveTranscriptClickPath('/Users/me/project/src/foo.ts', base)).toBe(
      '/Users/me/project/src/foo.ts',
    );
  });

  it('leaves Windows absolute paths unchanged', () => {
    expect(resolveTranscriptClickPath('C:\\proj\\foo.ts', 'C:\\proj')).toBe('C:\\proj\\foo.ts');
    expect(resolveTranscriptClickPath('C:/proj/foo.ts', 'C:/proj')).toBe('C:/proj/foo.ts');
  });

  it('leaves UNC absolute paths unchanged', () => {
    expect(resolveTranscriptClickPath('\\\\server\\share\\foo.ts', base)).toBe(
      '\\\\server\\share\\foo.ts',
    );
  });

  it('trims a trailing separator on the base dir', () => {
    expect(resolveTranscriptClickPath('src/foo.ts', '/Users/me/project/')).toBe(
      '/Users/me/project/src/foo.ts',
    );
  });

  it('returns the path unchanged when no base dir is available', () => {
    expect(resolveTranscriptClickPath('src/foo.ts', undefined)).toBe('src/foo.ts');
  });
});

/**
 * Which directory a relative path in a transcript is relative to. It used to be the window's
 * project, which is wrong for a session that lives elsewhere: an agent working in another
 * checkout writes paths relative to that checkout, and joining them onto this project's root
 * produced a file that does not exist.
 */
import { transcriptClickBase } from '../resolveTranscriptClickPath';

describe('transcriptClickBase', () => {
  it('prefers the session worktree, then the session own project, then the window project', () => {
    expect(transcriptClickBase({ sessionWorktreePath: '/wt/a', sessionWorkspacePath: '/proj/a', windowWorkspacePath: '/proj/w' })).toBe('/wt/a');
    expect(transcriptClickBase({ sessionWorktreePath: null, sessionWorkspacePath: '/proj/a', windowWorkspacePath: '/proj/w' })).toBe('/proj/a');
    expect(transcriptClickBase({ sessionWorktreePath: undefined, sessionWorkspacePath: undefined, windowWorkspacePath: '/proj/w' })).toBe('/proj/w');
  });

  it('ignores blank values rather than joining onto an empty base', () => {
    expect(transcriptClickBase({ sessionWorktreePath: '', sessionWorkspacePath: '  ', windowWorkspacePath: '/proj/w' })).toBe('/proj/w');
  });
});
