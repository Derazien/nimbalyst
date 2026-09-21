// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { kimiCliPromptForSubmit, stripNimbalystNote } from '../kimiCliPromptNote';
import { KimiCliWireTranslator } from '../kimiCliWireTranslator';

describe('the Nimbalyst note on a Kimi Code CLI session\'s first prompt', () => {
  const first = { isFirstPrompt: true, hasNimbalystTools: true };

  it('follows the user\'s own words, names the tool as kimi names it, and comes back out unchanged', () => {
    const typed = kimiCliPromptForSubmit('Fix the login bug', first);
    // The user's text leads, so kimi's own session title is still theirs.
    expect(typed.startsWith('Fix the login bug\n\n')).toBe(true);
    expect(typed).toContain('mcp__nimbalyst__update_session_meta');
    expect(stripNimbalystNote(typed)).toBe('Fix the login bug');
    // What kimi really records: the terminal lane types a line break as the two
    // characters backslash and n, because a real one would press Enter.
    expect(stripNimbalystNote(typed.replace(/\n/g, '\\n'))).toBe('Fix the login bug');
  });

  it('is only added once, to a first prompt, when kimi really has Nimbalyst\'s tools, and never to a slash command', () => {
    expect(kimiCliPromptForSubmit('again', { ...first, isFirstPrompt: false })).toBe('again');
    expect(kimiCliPromptForSubmit('hello', { ...first, hasNimbalystTools: false })).toBe('hello');
    // A slash command is kimi's own syntax; anything after it would become its argument.
    expect(kimiCliPromptForSubmit('/compact', first)).toBe('/compact');
  });

  it('never shows in the transcript: the user row is what the person typed', () => {
    const typed = kimiCliPromptForSubmit('Fix the login bug', first);
    const actions = new KimiCliWireTranslator().translateLine(JSON.stringify({
      type: 'turn.prompt', input: [{ type: 'text', text: typed }], origin: { kind: 'user' }, time: 5,
    }));
    expect(actions).toEqual([{ kind: 'row', direction: 'input', content: 'Fix the login bug', createdAt: new Date(5) }]);
  });
});
