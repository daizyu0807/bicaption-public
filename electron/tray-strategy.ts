export type TrayImageSource = 'app-icon' | 'template-file' | 'inline-template' | 'named-template';

type TrayImagePreferenceInput = {
  isPackaged: boolean;
};

export function getTrayImagePreferenceOrder({ isPackaged }: TrayImagePreferenceInput) {
  if (isPackaged) {
    return [
      'template-file',
      'inline-template',
      'named-template',
      'app-icon',
    ] satisfies TrayImageSource[];
  }

  return [
    'app-icon',
    'template-file',
    'inline-template',
    'named-template',
  ] satisfies TrayImageSource[];
}
