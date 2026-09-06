// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildDecisionDraft, appendStandaloneDecision } from '../decisionDraft';
import { parseDecisionFence } from '../decisionFence';

describe('decision authoring', () => {
  it('preserves identity and artifact metadata when an unanswered question is edited', () => {
    const previous = parseDecisionFence('id: dcn-stable\nask: Pick?\ntype: singleSelect\nfuture: keep\noptions:\n  - id: a\n    label: First\n    artifact: mockup.mockup.html\n  - id: b\n    label: Second')!;
    const next = parseDecisionFence(buildDecisionDraft({ question: 'Which?', type: 'singleSelect', entries: 'Updated first\nSecond', seed: '' }, previous))!;
    expect(next.id).toBe('dcn-stable');
    expect(next.raw.future).toBe('keep');
    expect(next.entries[0]).toMatchObject({ id: 'a', artifact: 'mockup.mockup.html', label: 'Updated first' });
    expect(next.asked).toEqual([]);
  });
  it('keeps edit-text seed literal and seeds only one standalone block', () => {
    const next = parseDecisionFence(buildDecisionDraft({ question: 'Revise?', type: 'editText', entries: '', seed: 'line one\n```yaml\nkey: value\n```' }))!;
    expect(next.seed).toBe('line one\n```yaml\nkey: value\n```');
    const markdown = appendStandaloneDecision('# Direction', 'Direction');
    expect(appendStandaloneDecision(markdown, 'Direction')).toBe(markdown);
    expect(markdown).toContain('draft: true');
  });
  it('does not allow an already sealed record to become a draft', () => {
    const previous = parseDecisionFence('id: settled\nask: Ship?\ntype: confirm\nresolved: true\nresolvedBy: Greg\nresolvedAt: "2026-09-05"')!;
    expect(() => buildDecisionDraft({ question: 'Undo?', type: 'confirm', entries: '', seed: '' }, previous)).toThrow('sealed');
  });
});
