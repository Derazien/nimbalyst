import React, { useState } from 'react';
import type { LexicalEditor } from 'lexical';
import type { DecisionBlockSource, FeedbackAskType } from '@nimbalyst/collab-protocol';
import { INSERT_DECISION_COMMAND } from './DecisionCommands';
import { buildDecisionDraft } from './decisionDraft';
import './DecisionComponent.css';

const ASK_TYPES: Array<[FeedbackAskType, string]> = [
  ['singleSelect', 'Choose one'], ['multiSelect', 'Choose several'], ['reorder', 'Rank options'],
  ['editText', 'Edit a draft'], ['confirm', 'Yes or no'], ['rating', 'Rate 1 to 5'],
];

export function DecisionAuthoring({ source, onSave, onCancel }: {
  source?: DecisionBlockSource;
  onSave: (content: string) => void;
  onCancel?: () => void;
}): React.JSX.Element {
  const [question, setQuestion] = useState(source?.ask ?? '');
  const [type, setType] = useState<FeedbackAskType>(source?.type ?? 'singleSelect');
  const [entries, setEntries] = useState(source?.entries.map((entry) => entry.label ?? entry.title ?? entry.id).join('\n') ?? '');
  const [seed, setSeed] = useState(source?.seed ?? '');
  const [error, setError] = useState('');
  return <form className="decision-authoring" onSubmit={(event) => {
    event.preventDefault();
    try { onSave(buildDecisionDraft({ question, type, entries, seed }, source)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The question could not be saved.'); }
  }}>
    <label>Question<input autoFocus value={question} onChange={(event) => setQuestion(event.target.value)} /></label>
    <label>Answer format<select value={type} onChange={(event) => setType(event.target.value as FeedbackAskType)}>
      {ASK_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    {['singleSelect', 'multiSelect', 'reorder'].includes(type) ? <label>Options, one per line<textarea rows={4} value={entries} onChange={(event) => setEntries(event.target.value)} /></label> : null}
    {type === 'editText' ? <label>Draft to edit<textarea rows={5} value={seed} onChange={(event) => setSeed(event.target.value)} /></label> : null}
    <div className="decision-quiet">Save the question, then choose teammates and send it from the document.</div>
    {error ? <div role="alert" className="decision-seal-error">{error}</div> : null}
    <div className="decision-authoring-actions">
      {onCancel ? <button type="button" className="decision-linkish" onClick={onCancel}>Cancel</button> : null}
      <button type="submit" className="decision-btn decision-btn--primary">Save question</button>
    </div>
  </form>;
}

export default function InsertDecisionDialog({ activeEditor, onClose }: { activeEditor: LexicalEditor; onClose: () => void }): React.JSX.Element {
  return <DecisionAuthoring onCancel={onClose} onSave={(content) => {
    activeEditor.dispatchCommand(INSERT_DECISION_COMMAND, { content });
    onClose();
  }} />;
}
