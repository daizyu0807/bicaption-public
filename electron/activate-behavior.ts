export interface ActivateWindowVisibility {
  settingsVisible: boolean;
  overlayVisible: boolean;
}

export type ActivateBehavior = 'show-settings' | 'noop';

export function getActivateBehavior({
  overlayVisible,
}: ActivateWindowVisibility): ActivateBehavior {
  if (overlayVisible) {
    return 'noop';
  }
  return 'show-settings';
}
