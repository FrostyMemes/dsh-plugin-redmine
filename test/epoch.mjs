import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceEpoch, isCurrentEpoch } from '../dist/shared/epoch.js';

test('late preflight results and old finally blocks cannot affect a newer launch epoch', async () => {
  const epoch = { current: 0 };
  const oldLaunchEpoch = advanceEpoch(epoch);
  let finishOldRequest;
  const oldRequest = new Promise(resolve => { finishOldRequest = resolve; });
  const newerLaunchEpoch = advanceEpoch(epoch);
  let openedDialog = false;
  let busyIssueId = 42;
  finishOldRequest({ sessions: [] });
  const response = await oldRequest;
  if (isCurrentEpoch(epoch, oldLaunchEpoch)) openedDialog = response.sessions.length > 0;
  if (isCurrentEpoch(epoch, oldLaunchEpoch)) busyIssueId = null;
  assert.equal(openedDialog, false);
  assert.equal(busyIssueId, 42);
  assert.equal(isCurrentEpoch(epoch, newerLaunchEpoch), true);
});
