export interface AudioDeviceOption {
  id: string;
  label: string;
  kind: string;
}

/** Dictation records from whatever macOS currently uses as the default input; the sidecar resolves it on every start. */
export const SYSTEM_DEFAULT_DEVICE_ID = '__system_default__';

export function isInputDevice(device: AudioDeviceOption) {
  return device.kind === 'input' || device.kind === 'duplex';
}

function getDeviceScore(device: AudioDeviceOption) {
  const label = device.label.toLowerCase();
  let score = 0;

  if (!isInputDevice(device)) {
    return Number.NEGATIVE_INFINITY;
  }

  if (/\b(macbook|built-in|builtin|internal)\b/.test(label)) {
    score += 300;
  }
  if (/\b(microphone|mic)\b/.test(label)) {
    score += 80;
  }
  if (/\b(usb|airpods|headset|headphones|external)\b/.test(label)) {
    score += 40;
  }
  if (/\b(iphone|ipad|continuity)\b/.test(label)) {
    score -= 300;
  }
  if (/\b(loopback|soundflower|background music)\b/.test(label)) {
    score -= 250;
  }

  return score;
}

export function pickPreferredInputDevice(devices: AudioDeviceOption[]) {
  return devices
    .filter(isInputDevice)
    .map((device, index) => ({ device, index, score: getDeviceScore(device) }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })[0]?.device ?? null;
}

/** Keep an explicit choice only while that input still exists; otherwise follow the system default. */
export function resolveDictationDeviceId(stored: string, devices: AudioDeviceOption[]) {
  if (!stored || stored === SYSTEM_DEFAULT_DEVICE_ID) {
    return SYSTEM_DEFAULT_DEVICE_ID;
  }
  return devices.some((device) => isInputDevice(device) && device.id === stored) ? stored : SYSTEM_DEFAULT_DEVICE_ID;
}
