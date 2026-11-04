import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from './queue.js';

test('a failed task is reported and later tasks still run, in order', async () => {
  const enqueue = createQueue();
  const ran = [];
  const errors = [];
  enqueue(async () => { ran.push('save 1'); }, (e) => errors.push(e.message));
  enqueue(async () => { throw new Error('network down'); }, (e) => errors.push(e.message));
  await enqueue(async () => { ran.push('save 2'); }, (e) => errors.push(e.message));
  assert.deepEqual(ran, ['save 1', 'save 2']);
  assert.deepEqual(errors, ['network down']);
});

test('an error handler that throws does not stop the queue either', async () => {
  const enqueue = createQueue();
  const ran = [];
  enqueue(async () => { throw new Error('x'); }, () => { throw new Error('handler failed'); }).catch(() => {});
  await enqueue(async () => { ran.push('next'); }, () => {});
  assert.deepEqual(ran, ['next']);
});
