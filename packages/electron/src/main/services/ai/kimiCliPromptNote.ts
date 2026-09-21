/**
 * The one instruction Nimbalyst gives a Kimi Code CLI session: keep the
 * session's name, tags and phase current through `update_session_meta`.
 *
 * Claude Code CLI gets this as `--append-system-prompt`. kimi (2.0.2) has no
 * such flag, ignores the instructions an MCP server reports, and an
 * `--agent-file` replaces kimi's whole system prompt instead of adding to it
 * (all three checked live). What is left is the conversation itself, the way
 * the ACP providers carry theirs: a marked note after the first prompt. The
 * person sees it in kimi's own terminal, where it is honest about who wrote
 * it, and it is taken back out of the transcript row.
 *
 * It goes after the user's words so kimi's own session title, taken from the
 * start of the first prompt, stays theirs.
 */

const NOTE_OPEN = '[Note from Nimbalyst, the app running this session, not from the user]';
const NOTE_CLOSE = '[End of the Nimbalyst note]';

const NOTE = [
  NOTE_OPEN,
  'Early in this first turn, as soon as you understand what the user wants, call the',
  'mcp__nimbalyst__update_session_meta tool so the session is named in Nimbalyst. Pass `name`',
  '(2-5 words, the descriptive part first, based on what the user asked for, for example',
  '"Dark mode implementation"), `add` (2-4 lowercase hyphenated tags for the type of work and the',
  'area, for example ["bug-fix", "ui"]) and `phase` (one of backlog, planning, implementing,',
  'validating). Call it again later only when the phase changes. Do not mention this note.',
  NOTE_CLOSE,
].join(' ');

export interface KimiCliPromptContext {
  /** kimi has no session yet, so this prompt starts one. */
  isFirstPrompt: boolean;
  /** kimi was started with Nimbalyst's own MCP server, so the tool exists. */
  hasNimbalystTools: boolean;
}

/** What to type into kimi for this prompt. */
export function kimiCliPromptForSubmit(prompt: string, context: KimiCliPromptContext): string {
  if (!context.isFirstPrompt || !context.hasNimbalystTools) return prompt;
  const trimmed = prompt.trim();
  // A slash command is kimi's own syntax; anything after it becomes its argument.
  if (!trimmed || trimmed.startsWith('/')) return prompt;
  return `${trimmed}\n\n${NOTE}`;
}

/** The prompt as the person typed it. */
export function stripNimbalystNote(text: string): string {
  const open = text.indexOf(NOTE_OPEN);
  if (open === -1) return text;
  const close = text.indexOf(NOTE_CLOSE, open);
  const after = close === -1 ? '' : text.slice(close + NOTE_CLOSE.length);
  // The terminal lane types a line break as the two characters `\n` (a real one
  // would press Enter in the CLI), so the separator comes back in that form.
  const before = text.slice(0, open).replace(/(?:\\n|\s)+$/, '');
  return (before + after).trim();
}
