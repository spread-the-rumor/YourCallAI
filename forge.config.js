module.exports = {
  packagerConfig: {
    icon: './assets/icon', // packager appends .ico (win) / .icns (mac)
    asar: {
      unpack: '**/node_modules/{get-windows,get-windows/**,koffi,koffi/**}/**',
    },
    extraResource: ['./agents/dist'],
    // Google SSO deep link — macOS registers the scheme from Info.plist via this.
    // (Windows registration is handled at install time by app.setAsDefaultProtocolClient.)
    protocols: [{ name: 'Your Call AI', schemes: ['yourcallai'] }],
  },
  // get-windows ships prebuilt N-API binaries — no per-Electron rebuild needed
  // (and rebuilding would require the VS C++ toolchain on Windows).
  rebuildConfig: { ignoreModules: ['get-windows'], force: false },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: { setupIcon: './assets/icon.ico' },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      // Branded macOS installer. darwin-only (appdmg needs macOS hdiutil); skipped on Windows.
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: { name: 'Your Call AI', icon: './assets/icon.icns', overwrite: true },
      // ponytail: default DMG layout; add a background PNG later if wanted
    },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: { owner: 'spread-the-rumor', name: 'YourCallAI' },
        draft: true,
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.js',
        devContentSecurityPolicy:
          "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' http://localhost:3100 ws://localhost:3000; media-src 'self' http://localhost:3100 blob:; img-src 'self' data:",
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              name: 'main_window',
              html: './src/renderer/index.html',
              js: './src/renderer/renderer.js',
              preload: { js: './src/preload.js' },
            },
            {
              name: 'popup_window',
              html: './src/popup/popup.html',
              js: './src/popup/popup.js',
              preload: { js: './src/popup/popupPreload.js' },
            },
            {
              name: 'recorder_window',
              html: './src/recorder/recorder.html',
              js: './src/recorder/recorder.js',
              preload: { js: './src/recorder/recorderPreload.js' },
            },
          ],
        },
      },
    },
  ],
};
