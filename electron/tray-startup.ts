type DockVisibilityInput = {
  trayCreated: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
};

export function shouldHideDockForTray({ trayCreated, isPackaged, platform }: DockVisibilityInput) {
  return platform === 'darwin' && isPackaged && trayCreated;
}

export function shouldKeepDockVisibleWithoutTray(input: DockVisibilityInput) {
  return !shouldHideDockForTray(input);
}
