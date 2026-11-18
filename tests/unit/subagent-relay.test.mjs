import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSubagentRelayReceipts } from '../../app/src/agent/subagent-relay.js';

test('reconnecting callers share the in-flight relay and recover its final receipt', async () => {
  const relay = createSubagentRelayReceipts();
  let confirmRelay;
  const confirmation = new Promise(resolve => { confirmRelay = resolve; });
  const confirmed = { ok: true, mode: 'parent_relay' };
  let forwards = 0;
  const request = {
    start: async () => {
      forwards += 1;
      return { observe: () => {} };
    },
    confirm: () => confirmation,
  };
  const disconnected = relay('original', 'same question', request);
  const reconnected = relay('original', 'same question', request);
  confirmRelay({ result: confirmed });
  assert.deepEqual(await reconnected, confirmed);
  assert.deepEqual(await disconnected, confirmed);
  assert.deepEqual(await relay('original', 'same question', request), confirmed);
  assert.equal((await relay('original', 'different question', request)).ok, false);
  assert.equal(forwards, 1);
  assert.deepEqual(await relay('new-message', 'same question', request), confirmed);
  assert.equal(forwards, 2);
});

test('pending receipt resumes observation while an unqueued send can retry', async () => {
  const relay = createSubagentRelayReceipts();
  const rejected = { ok: false, error: 'busy' };
  const waiting = { ok: false, error: 'pending' };
  const confirmed = { ok: true, mode: 'parent_relay' };
  const observe = () => {};
  let attempts = 0;
  let observations = 0;
  const request = {
    start: async () => (++attempts === 1 ? { result: rejected } : { observe }),
    confirm: async cursor => {
      assert.equal(cursor, observe);
      return ++observations === 1 ? { result: waiting, pending: true } : { result: confirmed };
    },
  };
  assert.deepEqual(await relay('retry', 'question', request), rejected);
  assert.deepEqual(await relay('retry', 'question', request), waiting);
  assert.deepEqual(await relay('retry', 'question', request), confirmed);
  assert.equal(attempts, 2);
  assert.equal(observations, 2);
});
