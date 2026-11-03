import test from 'node:test';
import assert from 'node:assert/strict';
import { claimOnce } from '../dist/shared/one-shot.js';

test('one-shot confirmation admits only the first rapid action', () => {
  const choice = { current: false };
  const createSessionCalls = [];
  const createNewSession = () => {
    if (!claimOnce(choice)) return;
    createSessionCalls.push('created');
  };

  createNewSession();
  createNewSession();

  assert.deepEqual(createSessionCalls, ['created']);
});
