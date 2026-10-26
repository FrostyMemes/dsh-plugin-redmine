import test from 'node:test';
import assert from 'node:assert/strict';
import { filterVisibleHealthSteps } from '../dist/client/ui.js';

test('connection result filtering hides only successful rows and preserves health input', () => {
  const steps = [
    { name: 'one', status: 'ok', message: 'ready' },
    { name: 'two', status: 'warning', message: 'partial' },
    { name: 'three', status: 'error', message: 'failed' },
    { name: 'four', status: 'skipped', message: 'not checked' },
  ];
  const visible = filterVisibleHealthSteps(steps, false);
  assert.deepEqual(visible.map(step => step.status), ['warning', 'error', 'skipped']);
  assert.deepEqual(filterVisibleHealthSteps(steps, true), steps);
  assert.equal(steps.length, 4);
  assert.equal(filterVisibleHealthSteps(steps.filter(step => step.status !== 'ok'), false).length, 3);
});
