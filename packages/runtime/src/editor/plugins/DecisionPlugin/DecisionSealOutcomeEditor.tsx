import React from 'react';
import type { DecisionBlockSource, DecisionResolvedValue } from '@nimbalyst/collab-protocol';
import { DecisionReorderControl } from './renderers/DecisionReorder';

export const SealOutcomeEditor: React.FC<{
  source: DecisionBlockSource;
  outcome: DecisionResolvedValue | undefined;
  onChange: (outcome: DecisionResolvedValue | undefined) => void;
}> = ({ source, outcome, onChange }) => {
  switch (source.type) {
    case "singleSelect":
      return (
        <label className="decision-seal-choice">
          Outcome
          <select
            value={typeof outcome === "string" ? outcome : ""}
            onChange={(event) => onChange(event.target.value || undefined)}
            data-testid="decision-seal-outcome"
          >
            <option value="">Choose an outcome</option>
            {source.entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label ?? entry.title ?? entry.id}
              </option>
            ))}
          </select>
        </label>
      );
    case "multiSelect": {
      const selected = Array.isArray(outcome) ? outcome : [];
      return (
        <fieldset
          className="decision-seal-choices"
          data-testid="decision-seal-outcome"
        >
          <legend>Outcome</legend>
          {source.entries.map((entry) => (
            <label key={entry.id}>
              <input
                type="checkbox"
                checked={selected.includes(entry.id)}
                onChange={() =>
                  onChange(
                    selected.includes(entry.id)
                      ? selected.filter((id) => id !== entry.id)
                      : [...selected, entry.id]
                  )
                }
              />
              {entry.label ?? entry.title ?? entry.id}
            </label>
          ))}
        </fieldset>
      );
    }
    case "reorder": {
      const orderedIds = Array.isArray(outcome)
        ? outcome
        : source.entries.map((entry) => entry.id);
      const removedIds = source.entries
        .map((entry) => entry.id)
        .filter((id) => !orderedIds.includes(id));
      return (
        <div data-testid="decision-seal-outcome">
          <DecisionReorderControl
            source={source}
            draft={{ type: "reorder", orderedIds, removedIds }}
            onDraftChange={(answer) => {
              if (answer.type === "reorder") onChange(answer.orderedIds);
            }}
            disabled={false}
            tally={null}
            members={[]}
            myAnswer={undefined}
          />
        </div>
      );
    }
    case "confirm":
      return (
        <label className="decision-seal-choice">
          Outcome
          <select
            value={typeof outcome === "boolean" ? String(outcome) : ""}
            onChange={(event) =>
              onChange(
                event.target.value === ""
                  ? undefined
                  : event.target.value === "true"
              )
            }
            data-testid="decision-seal-outcome"
          >
            <option value="">Break the tie</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      );
    case "rating":
    case "editText":
      return null;
  }
};

