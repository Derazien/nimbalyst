import React, { useState } from 'react';
import { $getNodeByKey } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { DecisionBlockSource } from '@nimbalyst/collab-protocol';
import { useDecisionConfiguration, useDecisionDeliveries } from '../../decisions/DecisionsContext';
import { $isDecisionNode } from './DecisionNode';
import { parseDecisionFence, serializeDecisionFence } from './decisionFence';

export function DecisionDeliveryPanel({ source, nodeKey }: { source: DecisionBlockSource; nodeKey: string }): React.JSX.Element | null {
  const config = useDecisionConfiguration();
  const [editor] = useLexicalComposerContext();
  const { deliveryStates: states, deliveryError, setDeliveryStates: setStates } = useDecisionDeliveries();
  const [recipientIds, setRecipientIds] = useState(() => source.asked.filter((id) => config?.getMembers?.().some((member) => member.id === id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const state = states.find((candidate) => candidate.blockId === source.id);
  const members = config?.getMembers?.() ?? [];
  const canSend = (config?.isHydrated?.() ?? true) && (config?.canVote?.() ?? true);

  if (!config?.requestDecision || source.raw.draft === true || (source.sealed && !state)) return null;
  const requestDecision = config.requestDecision;
  const run = async (operation: 'send' | 'nudge'): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      if (operation === 'send') {
        // Re-read inside the transaction: a remote seal or replacement while the
        // recipient picker was open must not be overwritten by this draft.
        let failure: string | undefined;
        editor.update(() => {
          const node = $getNodeByKey(nodeKey);
          if (!$isDecisionNode(node)) { failure = 'This question is no longer in the document.'; return; }
          const current = parseDecisionFence(node.getContent());
          if (!current || current.sealed || current.id !== source.id) { failure = 'This question has changed. Reopen it before sending.'; return; }
          node.setContent(serializeDecisionFence({ ...current, asked: recipientIds }));
        }, { discrete: true });
        if (failure) throw new Error(failure);
      }
      const result = await requestDecision(operation === 'send'
        ? { operation, blockId: source.id, recipientIds }
        : { operation, blockId: source.id });
      if (!config.onDecisionState) setStates(result.decisions, result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This question could not be sent.');
    } finally { setBusy(false); }
  };

  return <div className="decision-delivery">
    {state ? <>
      <span className="decision-quiet">{state.sealed ? 'Settled' : `${state.answeredCount ?? state.answeredIds.length} of ${state.recipientIds.length} asked teammates answered`}</span>
      {!state.sealed && state.sentBy === config.currentUser.id ? <button type="button" className="decision-linkish" disabled={busy || !canSend} onClick={() => void run('nudge')}>Remind unanswered teammates</button> : null}
    </> : <details>
      <summary>Ask teammates</summary>
      <div className="decision-recipients">
        {members.map((member) => <label key={member.id}><input type="checkbox" checked={recipientIds.includes(member.id)} disabled={busy || !canSend} onChange={() => setRecipientIds((ids) => ids.includes(member.id) ? ids.filter((id) => id !== member.id) : [...ids, member.id])} />{member.name}</label>)}
        {members.length === 0 ? <span className="decision-quiet">Team members are unavailable.</span> : null}
      </div>
      <button type="button" className="decision-btn decision-btn--primary" disabled={busy || !canSend || recipientIds.length === 0} onClick={() => void run('send')}>{busy ? 'Sending…' : 'Send question'}</button>
    </details>}
    {error || deliveryError ? <div role="alert" className="decision-seal-error">{error || deliveryError}</div> : null}
  </div>;
}
