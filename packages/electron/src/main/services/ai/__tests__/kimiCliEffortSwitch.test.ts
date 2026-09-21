// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { switchKimiCliEffort } from '../kimiCliEffortSwitch';
import { typeIntoKimiCliTerminal } from '../kimiCliRuntimes';

describe('typeIntoKimiCliTerminal', () => {
  it('lets one thing at a time type into a session\'s terminal, in the order asked, even after a failure', async () => {
    // The effort picker and a prompt are both keystrokes into the same kimi:
    // interleaved, the prompt text would land inside the picker.
    const order: string[] = [];
    const slow = typeIntoKimiCliTerminal('s1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('effort');
      throw new Error('kimi never confirmed');
    });
    const prompt = typeIntoKimiCliTerminal('s1', async () => { order.push('prompt'); return 'sent'; });
    const other = typeIntoKimiCliTerminal('s2', async () => { order.push('other session'); });

    await expect(slow).rejects.toThrow('kimi never confirmed');
    await expect(prompt).resolves.toBe('sent');
    await other;
    expect(order).toEqual(['other session', 'effort', 'prompt']);
  });
});

/** A kimi whose picker opens on Enter and whose status line changes on Alt+S. */
function fakeKimi(options: { current: string | null; picker?: string[] | null; confirms?: boolean }) {
  const writes: string[] = [];
  let current = options.current;
  let pickerOpen = false;
  let cursor = 0;
  const levels = options.picker === undefined ? ['low', 'high', 'max'] : options.picker;
  return {
    writes,
    deps: {
      write: (data: string) => {
        writes.push(data);
        if (data === '\r' && levels) { pickerOpen = true; cursor = Math.max(levels.indexOf(current ?? ''), 0); }
        if (data === '\x1b[D') cursor = Math.max(0, cursor - 1);
        if (data === '\x1b[C' && levels) cursor = Math.min(levels.length - 1, cursor + 1);
        if (data === '\x1bs' && pickerOpen && levels && options.confirms !== false) current = levels[cursor];
      },
      delay: async () => {},
      currentEffort: () => current,
      pickerLevels: () => (pickerOpen ? levels : null),
    },
  };
}

describe('switchKimiCliEffort', () => {
  it('walks kimi\'s own effort picker to the level and takes it for this session only (Alt+S)', async () => {
    const kimi = fakeKimi({ current: 'high' });
    await expect(switchKimiCliEffort({ effort: 'max', model: 'kimi-code-cli:k3' }, kimi.deps))
      .resolves.toEqual({ switched: true, effort: 'max' });
    // `/effort max` would also rewrite kimi's global default in config.toml, so
    // the picker is opened bare. Left cannot pass the first level, which makes
    // the walk right land on the level wherever the picker started.
    expect(kimi.writes).toEqual(['/', 'effort', ' ', '\r', '\x1b[D', '\x1b[D', '\x1b[D', '\x1b[C', '\x1b[C', '\x1bs']);
  });

  it('runs a level kimi does not have at the nearest one below, and types nothing when already there', async () => {
    const kimi = fakeKimi({ current: 'high' });
    await expect(switchKimiCliEffort({ effort: 'xhigh', model: 'kimi-code-cli:k3' }, kimi.deps))
      .resolves.toEqual({ switched: true, effort: 'high' });
    expect(kimi.writes).toEqual([]);
  });

  it('backs out of the picker and reports failure when the level is not offered or kimi never confirms', async () => {
    const missing = fakeKimi({ current: 'high', picker: ['on', 'max'] });
    await expect(switchKimiCliEffort({ effort: 'low', model: 'kimi-code-cli:k3' }, missing.deps)).resolves.toEqual({ switched: false });
    expect(missing.writes.at(-1)).toBe('\x1b');

    const silent = fakeKimi({ current: 'high', confirms: false });
    await expect(switchKimiCliEffort({ effort: 'low', model: 'kimi-code-cli:k3' }, silent.deps)).resolves.toEqual({ switched: false });
    expect(silent.writes.at(-1)).toBe('\x1b');
  });

  it('leaves a model with no effort levels alone', async () => {
    const kimi = fakeKimi({ current: 'on' });
    await expect(switchKimiCliEffort({ effort: 'max', model: 'kimi-code-cli:kimi-for-coding-highspeed' }, kimi.deps))
      .resolves.toEqual({ switched: false });
    expect(kimi.writes).toEqual([]);
  });
});
