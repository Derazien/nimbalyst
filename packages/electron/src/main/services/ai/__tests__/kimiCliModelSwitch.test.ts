// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { switchKimiCliModel } from '../kimiCliModelSwitch';

function deps(confirmAfterWrites: number | null) {
  const writes: string[] = [];
  let model: string | null = 'kimi-code/k3';
  return {
    writes,
    deps: {
      write: (data: string) => {
        writes.push(data);
        if (confirmAfterWrites !== null && writes.length === confirmAfterWrites) model = 'kimi-code/k3-256k';
      },
      delay: async () => {},
      currentModel: () => model,
    },
  };
}

describe('switchKimiCliModel', () => {
  it('opens kimi\'s own picker on the model and takes it for this session only (Alt+S), confirmed by the event log', async () => {
    const { writes, deps: d } = deps(5);
    await expect(switchKimiCliModel({ model: 'kimi-code-cli:k3-256k' }, d)).resolves.toEqual({ switched: true, cliArg: 'kimi-code/k3-256k' });
    // `/` alone opens the command menu; Enter runs `/model <name>`, which only
    // preselects the picker; Alt+S keeps kimi's global default untouched.
    expect(writes).toEqual(['/', 'model kimi-code/k3-256k', ' ', '\r', '\x1bs']);
  });

  it('reports failure when kimi never confirms, and backs out of the picker', async () => {
    const { writes, deps: d } = deps(null);
    await expect(switchKimiCliModel({ model: 'kimi-code-cli:k3-256k' }, d)).resolves.toEqual({ switched: false });
    expect(writes.at(-1)).toBe('\x1b');
  });

  it('does nothing for a model that is not a Kimi model, or the one already in use', async () => {
    const { writes, deps: d } = deps(null);
    await expect(switchKimiCliModel({ model: 'claude-code-cli:opus' }, d)).resolves.toEqual({ switched: false });
    await expect(switchKimiCliModel({ model: 'kimi-code-cli:k3' }, d)).resolves.toEqual({ switched: true, cliArg: 'kimi-code/k3' });
    expect(writes).toEqual([]);
  });
});
