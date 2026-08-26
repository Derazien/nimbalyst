/**
 * How a project is drawn when it is named somewhere other than its own window: the same
 * two-letter label and accent color the project rail uses, so a badge on a chip reads as
 * "that rail entry" and not as a new symbol to learn.
 */

import { generateWorkspaceAccentColor } from '../components/WorkspaceSummaryHeader';

/** The rail's label: first letters of the first two words, else the first two characters. */
export function projectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';
  const words = trimmed.split(/[-_\s]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/** The display name for a project path: its last segment. */
export function projectNameFromPath(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath;
}

export interface ProjectBadge {
  path: string;
  name: string;
  initials: string;
  color: string;
}

/** Everything a badge needs, from a path alone. */
export function projectBadgeFor(projectPath: string, name?: string): ProjectBadge {
  const displayName = name?.trim() || projectNameFromPath(projectPath);
  return {
    path: projectPath,
    name: displayName,
    initials: projectInitials(displayName),
    color: generateWorkspaceAccentColor(projectPath),
  };
}
