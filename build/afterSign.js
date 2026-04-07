// Re-sign the .app bundle with a unified ad-hoc signature AFTER
// electron-builder's own signing step. This ensures the main binary
// and Electron Framework share the same (ad-hoc) Team ID, preventing
// the "different Team IDs" crash on macOS when no Apple Developer
// certificate is available.
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

exports.default = async function (context) {
  if (process.platform !== 'darwin') return

  const appOutDir = context.appOutDir
  const productFilename = context.packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${productFilename}.app`)

  if (!fs.existsSync(appPath)) return

  try {
    execSync(`codesign --deep --force --sign - "${appPath}"`, { stdio: 'inherit' })
    console.log(`[afterSign] Re-signed: ${appPath}`)
  } catch (err) {
    console.warn(`[afterSign] codesign failed (non-fatal): ${err.message}`)
  }
}
