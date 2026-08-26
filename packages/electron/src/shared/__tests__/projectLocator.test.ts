// @vitest-environment node
/**
 * Which project owns a thing? Sessions and files answer differently and both answers
 * feed the same chip badge: a session lives in exactly one project (its workspace row),
 * a file lives in whichever known project is the longest prefix of its path, or in none.
 *
 * Pure on purpose. Main binds it to the window registry and the recent-projects list;
 * the renderer never compares paths itself.
 */
import { describe, expect, it } from 'vitest';
import { locatePathAmongProjects, locateSessionProject, pathsEqual } from '../projectLocator';

const WORK = 'C:/work';
const ARTINC = 'C:/work/artificial.inc';
const LOCALLEAD = 'C:/work/locallead';

const projects = [
  { path: WORK, name: 'work', isOpen: true },
  { path: ARTINC, name: 'artificial.inc', isOpen: true },
  { path: LOCALLEAD, name: 'locallead', isOpen: false },
];

describe('pathsEqual', () => {
  it('ignores separators, trailing slashes and, on Windows drive paths, case', () => {
    expect(pathsEqual('C:\\work\\locallead\\', 'c:/work/LOCALLEAD')).toBe(true);
    expect(pathsEqual('/home/me/proj', '/home/me/proj/')).toBe(true);
  });

  it('keeps case significant for paths that are not Windows drive paths', () => {
    expect(pathsEqual('/home/me/Proj', '/home/me/proj')).toBe(false);
  });
});

describe('locateSessionProject', () => {
  it('is not foreign when the session lives in the active project, however it is spelled', () => {
    expect(locateSessionProject('c:\\WORK', WORK)).toEqual({ project: 'c:\\WORK', foreign: false });
  });

  it('is foreign when the session lives elsewhere', () => {
    expect(locateSessionProject(ARTINC, WORK)).toEqual({ project: ARTINC, foreign: true });
  });

  it('has no project for a session row without a workspace', () => {
    expect(locateSessionProject(null, WORK)).toEqual({ project: null, foreign: false });
  });
});

describe('locatePathAmongProjects', () => {
  it('picks the longest matching project, not the first: a file under artificial.inc is not "work"', () => {
    expect(locatePathAmongProjects(`${ARTINC}/docs/plan.md`, projects, WORK)).toEqual({
      project: ARTINC,
      name: 'artificial.inc',
      isOpen: true,
      foreign: true,
    });
  });

  it('is not foreign for a file inside the active project, even when a parent project also matches', () => {
    expect(locatePathAmongProjects(`${ARTINC}/docs/plan.md`, projects, ARTINC)).toMatchObject({
      project: ARTINC,
      foreign: false,
    });
  });

  it('treats a file directly under the active project as home when no child project claims it', () => {
    expect(locatePathAmongProjects(`${WORK}/notes.md`, projects, WORK)).toMatchObject({
      project: WORK,
      foreign: false,
    });
  });

  it('flags a loose directory nobody registered as foreign with no project', () => {
    expect(locatePathAmongProjects('C:/Users/me/.claude/memory/MEMORY.md', projects, WORK)).toEqual({
      project: null,
      name: null,
      isOpen: false,
      foreign: true,
    });
  });

  it('does not confuse a sibling whose name merely starts the same way', () => {
    // C:/work/locallead_worktrees is not inside C:/work/locallead.
    expect(locatePathAmongProjects(`${LOCALLEAD}_worktrees/x/a.ts`, projects, ARTINC)).toMatchObject({
      project: WORK,
      foreign: true,
    });
  });

  it('matches case-insensitively on Windows drive paths', () => {
    expect(locatePathAmongProjects('c:\\Work\\Artificial.inc\\a.md', projects, WORK)).toMatchObject({
      project: ARTINC,
      foreign: true,
    });
  });
});
