// electron-builder afterPack hook
// Re-signs the app with the correct bundle identifier so macOS TCC
// shows "BiCaption" instead of "Electron" in permission dialogs.
// Also signs the sidecar binary with audio-input entitlement so it
// can access microphone/AirPods in the packaged app.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
// An ad-hoc signature's default designated requirement is the exact cdhash, so every rebuild looked like a different
// app to TCC and silently dropped the microphone / accessibility / screen-recording grants. Pin the requirement to the
// bundle identifier instead; the grants then survive rebuilds of this locally signed app.
//
// With BICAPTION_SIGN_IDENTITY set to a certificate name (see scripts/make-signing-cert.sh) every build is signed by the
// same certificate instead. codesign then writes `identifier ... and certificate leaf = H"..."` as the requirement on
// its own, which also lets an update be checked against the app that is already installed. BICAPTION_SIGN_KEYCHAIN
// points at the keychain holding that certificate. Without the variable nothing changes: ad-hoc signing as before.
const SIGN_IDENTITY = (process.env.BICAPTION_SIGN_IDENTITY || '').trim() || '-';
const SIGN_KEYCHAIN = (process.env.BICAPTION_SIGN_KEYCHAIN || '').trim();
const signFlags = `--sign "${SIGN_IDENTITY}"${SIGN_KEYCHAIN ? ` --keychain "${SIGN_KEYCHAIN}"` : ''}`;
const identifierRequirement = (identifier) => (
  SIGN_IDENTITY === '-' ? `--requirements '=designated => identifier "${identifier}"'` : ''
);

module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const mainBinary = path.join(appPath, 'Contents', 'MacOS', 'BiCaption');
  const entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');
  const entitlementsInherit = path.join(__dirname, '..', 'build', 'entitlements.mac.inherit.plist');

  if (!fs.existsSync(mainBinary)) {
    console.warn(`[afterPack] Main binary not found: ${mainBinary}`);
    return;
  }

  const bundleId = context.packager.appInfo.id; // com.davedai.bicaption

  console.log(`[afterPack] Re-signing with identifier=${bundleId} identity=${SIGN_IDENTITY === '-' ? 'ad-hoc' : SIGN_IDENTITY}`);

  // Sign sidecar binary with audio-input entitlement (it uses sounddevice
  // to capture from microphone/AirPods — without this it silently fails).
  const sidecarBinary = path.join(appPath, 'Contents', 'Resources', 'sidecar', 'bicaption-sidecar');
  const appleSttHelperApp = path.join(appPath, 'Contents', 'Resources', 'AppleSTTHelper.app');
  const appleSttHelperBinary = path.join(appleSttHelperApp, 'Contents', 'MacOS', 'apple-stt');
  const globalHotkeyHelperApp = path.join(appPath, 'Contents', 'Resources', 'GlobalHotkeyHelper.app');
  const globalHotkeyHelperBinary = path.join(globalHotkeyHelperApp, 'Contents', 'MacOS', 'global-hotkey');
  const helperResourcesDir = path.join(appleSttHelperApp, 'Contents', 'Resources');
  const appIconSource = path.join(__dirname, '..', 'build', 'icon.icns');
  if (fs.existsSync(sidecarBinary)) {
    console.log(`[afterPack] Signing sidecar with audio-input entitlement`);
    execSync(
      `codesign --force ${signFlags} --identifier "${bundleId}.sidecar" ${identifierRequirement(`${bundleId}.sidecar`)} --entitlements "${entitlementsInherit}" "${sidecarBinary}"`,
      { stdio: 'inherit' },
    );
    // Also sign all .dylib and .so files in the sidecar directory
    const sidecarDir = path.dirname(sidecarBinary);
    signDylibsRecursive(sidecarDir, entitlementsInherit);
  } else {
    console.warn(`[afterPack] Sidecar binary not found: ${sidecarBinary}`);
  }

  if (fs.existsSync(appleSttHelperBinary)) {
    const helperBundleId = `${bundleId}.apple-stt-helper`;
    if (fs.existsSync(appIconSource)) {
      fs.mkdirSync(helperResourcesDir, { recursive: true });
      fs.copyFileSync(appIconSource, path.join(helperResourcesDir, 'icon.icns'));
    } else {
      console.warn(`[afterPack] Helper icon not found: ${appIconSource}`);
    }
    console.log(`[afterPack] Signing AppleSTTHelper with identifier=${helperBundleId}`);
    execSync(
      `codesign --force ${signFlags} --identifier "${helperBundleId}" ${identifierRequirement(helperBundleId)} "${appleSttHelperBinary}"`,
      { stdio: 'inherit' },
    );
    execSync(
      `codesign --force ${signFlags} --identifier "${helperBundleId}" ${identifierRequirement(helperBundleId)} "${appleSttHelperApp}"`,
      { stdio: 'inherit' },
    );
  } else {
    console.warn(`[afterPack] AppleSTTHelper binary not found: ${appleSttHelperBinary}`);
  }

  if (fs.existsSync(globalHotkeyHelperBinary)) {
    const helperBundleId = `${bundleId}.global-hotkey-helper`;
    console.log(`[afterPack] Signing GlobalHotkeyHelper with identifier=${helperBundleId}`);
    execSync(
      `codesign --force ${signFlags} --identifier "${helperBundleId}" ${identifierRequirement(helperBundleId)} "${globalHotkeyHelperBinary}"`,
      { stdio: 'inherit' },
    );
    execSync(
      `codesign --force ${signFlags} --identifier "${helperBundleId}" ${identifierRequirement(helperBundleId)} "${globalHotkeyHelperApp}"`,
      { stdio: 'inherit' },
    );
  } else {
    console.warn(`[afterPack] GlobalHotkeyHelper binary not found: ${globalHotkeyHelperBinary}`);
  }

  // Sign Frameworks and helpers
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  if (fs.existsSync(frameworksDir)) {
    const items = fs.readdirSync(frameworksDir);
    for (const item of items) {
      const itemPath = path.join(frameworksDir, item);
      try {
        execSync(
          `codesign --force --deep ${signFlags} --entitlements "${entitlementsInherit}" "${itemPath}"`,
          { stdio: 'pipe' },
        );
      } catch {
        // Some items may already be signed or not need signing
      }
    }
  }

  // Sign the main binary with the correct identifier
  execSync(
    `codesign --force ${signFlags} --identifier "${bundleId}" ${identifierRequirement(bundleId)} --entitlements "${entitlements}" "${mainBinary}"`,
    { stdio: 'inherit' },
  );

  // Sign the app bundle
  execSync(
    `codesign --force ${signFlags} --identifier "${bundleId}" ${identifierRequirement(bundleId)} --entitlements "${entitlements}" "${appPath}"`,
    { stdio: 'inherit' },
  );

  // Verify
  const result = execSync(`codesign -dvvv "${mainBinary}" 2>&1`, { encoding: 'utf8' });
  const idMatch = result.match(/Identifier=(.+)/);
  console.log(`[afterPack] Signed identifier: ${idMatch ? idMatch[1] : 'unknown'}`);
};

function signDylibsRecursive(dir, entitlements) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      signDylibsRecursive(fullPath, entitlements);
    } else if (entry.name.endsWith('.dylib') || entry.name.endsWith('.so')) {
      try {
        execSync(`codesign --force ${signFlags} --entitlements "${entitlements}" "${fullPath}"`, { stdio: 'pipe' });
      } catch {
        // ignore signing failures for individual libs
      }
    }
  }
}
