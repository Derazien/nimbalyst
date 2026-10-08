// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { detectClaudeCliPermissionMode } from '../claudeCliModeDetector';

const RULE = '─'.repeat(60);
const promptScreen = (footer: string[], above: string[] = ['  Done. I updated the file.']) => [
  ...above,
  '',
  RULE,
  '❯ ',
  RULE,
  ...footer,
];

describe('detectClaudeCliPermissionMode', () => {
  it.each([
    ['plan', '  ⏸ plan mode on (shift+tab to cycle)'],
    ['bypassPermissions', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'],
    ['acceptEdits', '  ⏵⏵ accept edits on (shift+tab to cycle)'],
    ['acceptEdits', '  ⏵⏵ auto-accept edits on (shift+tab to cycle)'],
    ['auto', '  ⏵⏵ auto mode on (shift+tab to cycle)'],
    ['plan', 'plan mode on'],
  ])('reads %s from the footer %j', (mode, footer) => {
    expect(detectClaudeCliPermissionMode(promptScreen([footer]))).toBe(mode);
  });

  it('reads the footer even when it carries trailing status text', () => {
    expect(
      detectClaudeCliPermissionMode(promptScreen(['  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt'])),
    ).toBe('bypassPermissions');
  });

  it('reads default from the shortcuts hint or from a bare idle prompt box', () => {
    expect(detectClaudeCliPermissionMode(promptScreen(['  ? for shortcuts']))).toBe('default');
    expect(detectClaudeCliPermissionMode(promptScreen(['  manual mode on (shift+tab to cycle)']))).toBe('default');
    // The hint disappears while typing; the framed prompt row still identifies the idle CLI.
    expect(detectClaudeCliPermissionMode(promptScreen([]))).toBe('default');
  });

  it('is not fooled by mode words in the transcript above the prompt box', () => {
    const screen = promptScreen(['  ? for shortcuts'], ['  Press shift+tab until "plan mode on" shows.', '  ⏸ plan mode on']);
    expect(detectClaudeCliPermissionMode(screen)).toBe('default');
  });

  it('returns null while a selection dialog replaces the prompt (no flapping)', () => {
    const planApproval = [
      ' Ready to code?',
      ' Would you like to proceed?',
      ' ❯ 1. Yes, and bypass permissions',
      '   2. Yes, manually approve edits',
      '   3. No, keep planning',
      '',
      ' ctrl-g to edit in editor · Esc to cancel',
    ];
    expect(detectClaudeCliPermissionMode(planApproval)).toBeNull();
    // Even if a stale mode footer is still on screen under the dialog.
    expect(detectClaudeCliPermissionMode([...planApproval, '  ⏸ plan mode on'])).toBeNull();
    expect(detectClaudeCliPermissionMode([' Select model', ' Enter to select · ↑/↓ to navigate'])).toBeNull();
  });

  it('returns null for screens that are not the CLI prompt', () => {
    expect(detectClaudeCliPermissionMode([])).toBeNull();
    expect(detectClaudeCliPermissionMode(['', '   ', ''])).toBeNull();
    expect(detectClaudeCliPermissionMode(['PS C:\\work\\proj> ', ''])).toBeNull();
    expect(detectClaudeCliPermissionMode(['Welcome to Claude Code', 'Loading MCP servers...'])).toBeNull();
    expect(detectClaudeCliPermissionMode(undefined)).toBeNull();
  });
});
