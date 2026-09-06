import React, { useEffect, useState } from 'react';
import { $getRoot, $isElementNode, type LexicalEditor, type LexicalNode } from 'lexical';
import { $isDecisionNode } from './DecisionNode';
import { parseDecisionFence } from './decisionFence';

interface OpenQuestion { id: string; key: string; question: string }

/** Includes unsent blocks, which intentionally have no delivery record yet. */
export function readOpenDecisions(editor: LexicalEditor): OpenQuestion[] {
  return editor.getEditorState().read(() => {
    const result: OpenQuestion[] = [];
    const visit = (node: LexicalNode): void => {
      if ($isDecisionNode(node)) {
        const source = parseDecisionFence(node.getContent());
        if (source && !source.sealed) result.push({ id: source.id, key: node.getKey(), question: source.ask });
      } else if ($isElementNode(node)) node.getChildren().forEach(visit);
    };
    visit($getRoot());
    return result;
  });
}

export function DecisionOutline({ editor }: { editor: LexicalEditor | null }): React.JSX.Element | null {
  const [questions, setQuestions] = useState<OpenQuestion[]>([]);
  useEffect(() => {
    if (!editor) { setQuestions([]); return; }
    const read = (): void => {
      const next = readOpenDecisions(editor);
      setQuestions((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    read();
    return editor.registerUpdateListener(read);
  }, [editor]);
  if (questions.length === 0) return null;
  return <details className="decision-outline">
    <summary>{questions.length} open {questions.length === 1 ? 'question' : 'questions'}</summary>
    <div>{questions.map((question) => <button type="button" key={question.id} className="decision-linkish" onClick={() => editor?.getElementByKey(question.key)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>{question.question}</button>)}</div>
  </details>;
}
