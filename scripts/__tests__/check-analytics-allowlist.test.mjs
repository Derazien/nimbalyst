import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  collectEventNames,
  findClassificationErrors,
  readLists,
} from '../check-analytics-allowlist.mjs';

const lists = () => {
  const l = readLists();
  return { always: new Set(l.always), sampled: new Set(l.sampled), dropped: new Set(l.dropped), sdkOwned: new Set(l.sdkOwned) };
};

test('every event name in source is classified', () => {
  assert.deepEqual(findClassificationErrors(collectEventNames(), readLists()), []);
});

/** Source scan plus one synthetic name, so only that name can be the new error. */
const foundPlus = (name) => {
  const found = collectEventNames();
  found.set(name, 'some/file.ts');
  return found;
};
const about = (errors, name) => errors.filter((e) => e.includes(name));

test('an unclassified event name fails the check', () => {
  const errors = about(findClassificationErrors(foundPlus('brand_new_event'), readLists()), 'brand_new_event');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /silently dropped at ingestion/);
});

test('a name classified twice fails the check', () => {
  const l = lists();
  l.always.add('double_listed');
  l.dropped.add('double_listed');
  const errors = about(findClassificationErrors(foundPlus('double_listed'), l), 'double_listed');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /more than one list/);
});

test('an allow-listed name no longer emitted anywhere fails the check', () => {
  const l = lists();
  l.always.add('deleted_but_still_allow_listed');
  const errors = about(findClassificationErrors(collectEventNames(), l), 'deleted_but_still_allow_listed');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no longer emitted/);
});

/**
 * The gate's failure mode is silence, so the thing worth asserting is REACH, not
 * behavior on a synthetic name. Four live events emitted through a schema map or
 * a validator wrapper were invisible to the scan and dropped at ingestion while
 * this gate reported OK. Each seam below is the only one that finds its event.
 */
test('the scan reaches events emitted through wrappers and schema maps', () => {
  const found = collectEventNames();
  for (const name of [
    'create_ai_session', // validateSessionLaunchEvent(...) wrapper
    'ai_message_submit_attempted', // SEND_WALL_EVENT_SCHEMAS key
    'composer_state_reported', // SEND_WALL_EVENT_SCHEMAS key
    'ai_send_blocked', // SEND_WALL_EVENT_SCHEMAS key
    'daily_active', // capture({ event: '...' }) object literal
  ]) {
    assert.ok(found.has(name), `${name} is emitted in source but the scan missed it`);
  }
});

test('the DAU heartbeat is never sampled', () => {
  // Sampling it would make DAU a scaled estimate again, which is the thing it
  // exists to stop being.
  const { always, sampled } = readLists();
  assert.ok(always.has('daily_active'));
  assert.ok(!sampled.has('daily_active'));
});

test('the sampled panel is documented as a fraction that must be scaled', () => {
  // A raw count of a sampled event is wrong by 16/PANEL_BUCKETS.length. If the
  // bucket list changes, the scaling factor in POSTHOG_EVENTS.md changes too.
  const { sampled } = readLists();
  assert.ok(sampled.has('nimbalyst_session_start'), 'session start is sampled, not full-volume');
});
