import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual main-process lifecycle against a small Electron host.
function createHost() {
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const windowFunctions = source.slice(source.indexOf('function createSettingsWindow()'), source.indexOf('function isWindowVisible('));
  const startup = source.split("app.whenReady().then(() => {")[1].split("  ipcMain.handle('settings:load'")[0];
  let dockVisible = false;
  let window: any;
  class BrowserWindow {
    visible: boolean;
    focused = false;
    minimized = false;
    handlers = new Map<string, (...args: any[]) => void>();
    webContents = { openDevTools() {} };
    constructor(options: { show?: boolean }) { this.visible = options.show !== false; window = this; }
    on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler); }
    once(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler); }
    loadURL() { return Promise.resolve(); }
    hide() { this.visible = false; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    isDestroyed() { return false; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
  }
  const context = vm.createContext({ BrowserWindow, preloadPath: '', rendererEntry: '', isDev: false,
    isPackaged: true, isQuitting: false, trayAvailable: true, settingsWindow: null,
    app: { dock: { show() { dockVisible = true; }, hide() { dockVisible = false; } } },
    process: { platform: 'darwin', env: {} }, traceMain() {}, logEnvironmentReport() {},
    createOverlayWindow() {}, createTray() { return true; },
    shouldHideDockForTray() { return true; }, shouldKeepDockVisibleWithoutTray() { return false; },
  });
  vm.runInContext(windowFunctions, context);
  return { start() { vm.runInContext(`(() => {${startup}})()`, context); },
    get window() { return window; }, get dockVisible() { return dockVisible; },
    show() { vm.runInContext('showSettingsWindow()', context); } };
}

test('packaged cold launch presents and focuses settings after content is ready', () => {
  const host = createHost();
  host.start();
  host.window.handlers.get('ready-to-show')?.();
  assert.equal(host.window.visible, true);
  assert.equal(host.window.focused, true);
  assert.equal(host.dockVisible, true);
});

test('closing settings keeps the app available in the tray', () => {
  const host = createHost();
  host.start();
  host.window.handlers.get('ready-to-show')?.();
  host.window.handlers.get('close')({ preventDefault() {} });
  assert.equal(host.window.visible, false);
  assert.equal(host.dockVisible, false);
});

test('opening settings restores a minimized window before focusing it', () => {
  const host = createHost();
  host.start();
  host.window.minimized = true;
  host.show();
  assert.equal(host.window.minimized, false);
  assert.equal(host.window.focused, true);
});
