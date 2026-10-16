import { execFile } from 'node:child_process';

type Bounds = { x: number; y: number; width: number; height: number };
export function resolveNativeFocusGeometry(window: Bounds, input: Bounds | null) {
  const validInput = input && Object.values(input).every(Number.isFinite)
    && input.width > 0 && input.height > 0
    && input.x >= window.x - 2 && input.y >= window.y - 2
    && input.x + input.width <= window.x + window.width + 2
    && input.y + input.height <= window.y + window.height + 2;
  return { window, input: validInput ? input : null };
}

const nativeWindowScript = `
ObjC.import('Cocoa'); ObjC.import('Quartz');
var pid = Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
var entries = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)));
var window = entries.find(w => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && w.kCGWindowAlpha > 0 && w.kCGWindowBounds.Width > 0 && w.kCGWindowBounds.Height > 0);
var b = window ? window.kCGWindowBounds : null;
JSON.stringify({pid:pid,bounds:b ? {x:b.X,y:b.Y,width:b.Width,height:b.Height} : null});
`;

export async function readNativeFocusWindow(): Promise<{ pid: number; bounds: Bounds } | null> {
  if (process.platform !== 'darwin') return null;
  return new Promise(resolve => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', nativeWindowScript], { timeout: 2000 }, (error, stdout) => {
    if (error) { resolve(null); return; }
    try {
      const result = JSON.parse(stdout);
      const b = result.bounds;
      resolve(Number.isInteger(result.pid) && b && [b.x,b.y,b.width,b.height].every(Number.isFinite) && b.width > 0 && b.height > 0 ? result : null);
    } catch { resolve(null); }
  }));
}
