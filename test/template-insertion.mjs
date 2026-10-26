import test from 'node:test';
import assert from 'node:assert/strict';
import { insertAtSelection } from '../dist/client/ui.js';

test('template variable insertion replaces the current selection and returns the new caret', () => {
  const result = insertAtSelection('Начало конец', '{{issue.id}}', 7, 12);
  assert.deepEqual(result, { text: 'Начало {{issue.id}}', caret: 19 });
});

test('template variable insertion clamps selection offsets to the prompt boundaries', () => {
  assert.deepEqual(insertAtSelection('prompt', '{{status}}', 100, 200), { text: 'prompt{{status}}', caret: 16 });
});
