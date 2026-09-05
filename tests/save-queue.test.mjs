import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaveQueue } from '../src/save-queue.js';

test('writes snapshots in order and flush waits for the last write', async () => {
  const written = [];
  const queue = createSaveQueue(async data => { await new Promise(r => setTimeout(r, 5)); written.push(data.name); });
  const data = { name: 'Primeira' };
  const first = queue.save(data);
  data.name = 'Segunda';
  const second = queue.save(data);
  await queue.flush(); await Promise.all([first, second]);
  assert.deepEqual(written, ['Primeira', 'Segunda']);
});

test('a failed write can be retried when closing; later edits recover normally', async () => {
  let fail = true;
  const written = [];
  const queue = createSaveQueue(async data => { if (fail) throw Error('disk full'); written.push(data.name); });
  await assert.rejects(queue.save({ name: 'Preservada' }));
  await assert.rejects(queue.flush());
  fail = false;
  await queue.flush();
  await queue.save({ name: 'Nova' });
  assert.deepEqual(written, ['Preservada', 'Nova']);
});
