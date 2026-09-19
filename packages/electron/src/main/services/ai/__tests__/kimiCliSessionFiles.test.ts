// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  JsonlFollower,
  findKimiSessionDir,
  findNewKimiSession,
  kimiSessionIndexMark,
} from '../kimiCliSessionFiles';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-files-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const row = (sessionId: string, workDir: string) =>
  JSON.stringify({ sessionId, sessionDir: `C:/Users/x/.kimi-code/sessions/wd/${sessionId}`, workDir }) + '\n';

describe('findNewKimiSession', () => {
  it('finds only a row added after the mark, for this folder, not claimed by another session', () => {
    const index = path.join(dir, 'session_index.jsonl');
    fs.writeFileSync(index, row('session_old', 'C:/ws'));
    const mark = kimiSessionIndexMark(index);
    const claimed = new Set(['session_taken']);
    const find = () => findNewKimiSession({ indexPath: index, sinceOffset: mark, workDir: 'C:\\ws\\', isClaimed: (id) => claimed.has(id) });

    expect(find()).toBeNull();
    fs.appendFileSync(index, row('session_other_folder', 'C:/elsewhere') + row('session_taken', 'C:/ws'));
    expect(find()).toBeNull();
    fs.appendFileSync(index, row('session_new', 'c:/WS'));
    expect(find()?.sessionId).toBe('session_new');
  });

  it('treats a missing index as empty', () => {
    const index = path.join(dir, 'nope.jsonl');
    expect(kimiSessionIndexMark(index)).toBe(0);
    expect(findNewKimiSession({ indexPath: index, sinceOffset: 0, workDir: 'C:/ws', isClaimed: () => false })).toBeNull();
  });

  it('resolves a stored session id to its directory for resume', () => {
    const index = path.join(dir, 'session_index.jsonl');
    fs.writeFileSync(index, row('session_a', 'C:/ws') + 'garbage\n' + row('session_b', 'C:/ws'));
    expect(findKimiSessionDir(index, 'session_b')).toBe('C:/Users/x/.kimi-code/sessions/wd/session_b');
    expect(findKimiSessionDir(index, 'session_missing')).toBeNull();
  });
});

describe('JsonlFollower', () => {
  it('hands over each complete line once, holding a partial line (even a split UTF-8 character) until it ends', () => {
    const file = path.join(dir, 'wire.jsonl');
    const lines: string[] = [];
    const follower = new JsonlFollower(file, (l) => lines.push(l));

    follower.poll();
    expect(lines).toEqual([]);

    const second = Buffer.from('{"b":"☃"}\n', 'utf8');
    fs.writeFileSync(file, '{"a":1}\n');
    fs.appendFileSync(file, second.subarray(0, 7)); // ends inside the 3-byte snowman
    follower.poll();
    expect(lines).toEqual(['{"a":1}']);

    fs.appendFileSync(file, second.subarray(7));
    follower.poll();
    follower.poll();
    expect(lines).toEqual(['{"a":1}', '{"b":"☃"}']);
  });

  it('skips what is already in the file when resuming', () => {
    const file = path.join(dir, 'wire.jsonl');
    fs.writeFileSync(file, '{"old":1}\n');
    const lines: string[] = [];
    const follower = new JsonlFollower(file, (l) => lines.push(l), { startAtEnd: true });
    fs.appendFileSync(file, '{"new":1}\n');
    follower.poll();
    expect(lines).toEqual(['{"new":1}']);
  });
});
