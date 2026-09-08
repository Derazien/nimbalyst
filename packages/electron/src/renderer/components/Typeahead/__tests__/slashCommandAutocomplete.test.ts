// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildSlashCommandOptions, supportsWorkspaceSlashCommands, type SlashCommandEntry } from '../slashCommandAutocomplete';

describe('buildSlashCommandOptions', () => {
  it('sorts search matches alphabetically regardless of incoming order or match score', () => {
    const commands: SlashCommandEntry[] = [
      { name: 'investigate-performance', source: 'project' },
      { name: 'investigate', source: 'user', argumentHint: '<problem>' },
      { name: 'debug-investigate', source: 'plugin' },
      { name: 'review', source: 'builtin' },
    ];

    for (const query of ['inv', 'INV', 'investigate']) {
      expect(buildSlashCommandOptions(commands, query, 'commands').map(option => option.id)).toEqual([
        'debug-investigate',
        'investigate',
        'investigate-performance',
      ]);
    }
    expect(commands[0].name).toBe('investigate-performance');
  });
});

describe('supportsWorkspaceSlashCommands', () => {
  it('enables slash autocomplete for OpenCode sessions', () => {
    expect(supportsWorkspaceSlashCommands('opencode')).toBe(true);
  });

  it('enables slash autocomplete for terminal-CLI Claude sessions (NIM-819)', () => {
    expect(supportsWorkspaceSlashCommands('claude-code-cli')).toBe(true);
  });

  it('keeps chat-only providers disabled', () => {
    expect(supportsWorkspaceSlashCommands('openai')).toBe(false);
  });
});
