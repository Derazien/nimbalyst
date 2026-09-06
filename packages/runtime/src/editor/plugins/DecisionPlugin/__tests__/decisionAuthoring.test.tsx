import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DecisionAuthoring } from '../DecisionAuthoring';
import { parseDecisionFence } from '../decisionFence';
import { describe, expect, it } from 'vitest';
import { createEditor } from 'lexical';
import { DecisionNode, $createDecisionNode } from '../DecisionNode';

// Link targets must remain reachable after a decision has been sealed and its
// interactive decorator has collapsed. The node container owns the anchor.
describe('decision document anchors', () => {
  it('retains the same anchor container across an outcome update', () => {
    const editor = createEditor({ nodes: [DecisionNode], onError: (error) => { throw error; } });
    editor.update(() => {
      const original = $createDecisionNode({ content: 'id: dcn-linked\nask: Ship?\ntype: confirm' });
      const element = original.createDOM(editor._config, editor);
      expect(element.id).toBe('decision-dcn-linked');
      expect(element.dataset.decisionId).toBe('dcn-linked');
      const sealed = $createDecisionNode({ content: original.getContent() + '\nresolved: true' });
      expect(sealed.updateDOM(original, element)).toBe(false);
      expect(element.id).toBe('decision-dcn-linked');
    }, { discrete: true });
  });
});


it('composes a decision block without sending and retains multiline edit proposals', () => {
  let saved = '';
  render(<DecisionAuthoring onSave={(content) => { saved = content; }} />);
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'How should this read?' } });
  fireEvent.change(screen.getByLabelText('Answer format'), { target: { value: 'editText' } });
  fireEvent.change(screen.getByLabelText('Draft to edit'), { target: { value: 'First paragraph.\n\nSecond paragraph.' } });
  fireEvent.click(screen.getByText('Save question'));
  const source = parseDecisionFence(saved)!;
  expect(source.seed).toBe('First paragraph.\n\nSecond paragraph.');
  expect(source.asked).toEqual([]);
  expect(source.sealed).toBeUndefined();
});
