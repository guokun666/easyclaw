// Re-sign the .app bundle with a unified ad-hoc signature after packing.
// This ensures the main binary and Electron Framework share the same
// (ad-hoc) Team ID, preventing the "different Team IDs" crash on macOS
// when no Apple Developer certificate is available.
//
// Only runs on the final universal build (skips x64/arm64 intermediate builds)
// to avoid SHA mismatch when merging into a universal binary.
const { execSync } = require('child_process')
const path = require('path')

exports.default = async function (context) {
  if (process.platform !== 'darwin') return
  if (context.arch !== 4 /* Arch.universal */) return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  try {
    execSync(`codesign --deep --force --sign - "${appPath}"`, { stdio: 'inherit' })
    console.log(`[afterPack] Re-signed: ${appPath}`)
  } catch (err) {
    console.warn(`[afterPack] codesign failed (non-fatal): ${err.message}`)
  }
}
