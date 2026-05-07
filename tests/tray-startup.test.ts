import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldHideDockForTray, shouldKeepDockVisibleWithoutTray } from '../electron/tray-startup.ts';

test('dock hides only when tray creation succeeds', () => {
  assert.equal(shouldHideDockForTray({
    trayCreated: true,
    isPackaged: true,
    platform: 'darwin',
  }), true);
  assert.equal(shouldHideDockForTray({
    trayCreated: false,
    isPackaged: true,
    platform: 'darwin',
  }), false);
  assert.equal(shouldHideDockForTray({
    trayCreated: true,
    isPackaged: false,
    platform: 'darwin',
  }), false);
});

test('dock stays visible in dev even when tray creation succeeds', () => {
  assert.equal(shouldKeepDockVisibleWithoutTray({
    trayCreated: true,
    isPackaged: false,
    platform: 'darwin',
  }), true);
});

test('dock stays visible when tray creation fails', () => {
  assert.equal(shouldKeepDockVisibleWithoutTray({
    trayCreated: false,
    isPackaged: true,
    platform: 'darwin',
  }), true);
  assert.equal(shouldKeepDockVisibleWithoutTray({
    trayCreated: true,
    isPackaged: true,
    platform: 'darwin',
  }), false);
});

test('dock stays visible on non-mac platforms', () => {
  assert.equal(shouldKeepDockVisibleWithoutTray({
    trayCreated: true,
    isPackaged: true,
    platform: 'win32',
  }), true);
});
