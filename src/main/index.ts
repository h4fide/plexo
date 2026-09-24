import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon-dark.png?asset'
import { registerIpcHandlers } from './ipc/handlers'
import { loadThemeSource, migrateLegacyNetworkPreferences } from './settings'
import { testKnobs } from './testKnobs'
import { IpcChannels } from '../shared/ipc-channels'
import type { DownloadManager } from './download/downloadManager'

// In dev mode the app runs as the raw `electron` binary, which otherwise shows "Electron" in
// the Dock tooltip/menu bar — must be set before the app is ready. Packaged builds already get
// this from electron-builder's productName, but setting it here keeps dev and packaged in sync.
app.setName('Plexo')

// Each e2e test runs against its own throwaway userData folder (downloads, manifests, settings).
if (testKnobs.userDataDir) app.setPath('userData', testKnobs.userDataDir)

let mainWindow: BrowserWindow | null = null
let downloadManager: DownloadManager | null = null
let quitAfterSuspending = false
let pendingProtocolUrl: string | null = null

function handleIncomingProtocolUrl(value: string): void {
  try {
    const protocolUrl = new URL(value)
    if (protocolUrl.protocol !== 'plexo:') return

    const downloadUrl = protocolUrl.searchParams.get('url')
    if (!downloadUrl) return

    const targetUrl = new URL(downloadUrl)
    if (!['http:', 'https:'].includes(targetUrl.protocol)) return

    pendingProtocolUrl = targetUrl.toString()
    console.info('[plexo] received protocol URL', pendingProtocolUrl)
  } catch {
    console.warn('[plexo] ignored invalid protocol URL')
  }
}

function protocolUrlFromArgs(args: string[]): string | undefined {
  return args.find((argument) => argument.startsWith('plexo://'))
}

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  const initialProtocolUrl = protocolUrlFromArgs(process.argv)
  if (initialProtocolUrl) handleIncomingProtocolUrl(initialProtocolUrl)

  app.on('second-instance', (_event, commandLine) => {
    const protocolUrl = protocolUrlFromArgs(commandLine)
    if (protocolUrl) handleIncomingProtocolUrl(protocolUrl)

    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on('open-url', (event, value) => {
    event.preventDefault()
    handleIncomingProtocolUrl(value)
  })
}

// Only wired in dev — mirrors the default Electron menu (app/edit/view/window) plus one item to
// toggle the renderer's floating simulate-download panel, which itself only renders in dev.
function installDevMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        label: 'Developer',
        submenu: [
          {
            label: 'Toggle Dev Tools Panel',
            accelerator: 'CmdOrCtrl+Shift+D',
            click: () => mainWindow?.webContents.send(IpcChannels.toggleDevToolsPanel)
          }
        ]
      }
    ])
  )
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 620,
    minHeight: 420,
    show: false,
    autoHideMenuBar: true,
    title: 'Plexo',
    // Matches the renderer's dark-mode background so a live window resize
    // (which briefly exposes the raw window background) doesn't flash white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    // Design v2 draws its own logo + status readout where the title normally sits — on macOS,
    // keep the real traffic lights (still native, still draggable) but let the renderer's own
    // title bar occupy the rest of the strip instead of an OS-drawn title.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // A hidden e2e window would otherwise have its timers throttled.
      backgroundThrottling: !testKnobs.hideWindow
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!testKnobs.hideWindow) mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only hand http(s) links to the OS shell — an arbitrary scheme (e.g. a custom protocol
    // handler) reaching shell.openExternal is a known Electron risk if this ever fires with
    // attacker- or server-influenced data.
    if (/^https?:/i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  if (!gotLock) return

  electronApp.setAppUserModelId('com.plexo.app')

  if (process.defaultApp) {
    const devEntryPoint = process.argv[1]
    if (devEntryPoint) {
      app.setAsDefaultProtocolClient('plexo', process.execPath, [devEntryPoint])
    }
  } else {
    app.setAsDefaultProtocolClient('plexo')
  }

  // A failed move keeps the old file, to retry next launch — it must never stop the window opening.
  await migrateLegacyNetworkPreferences().catch((error) =>
    console.error('[plexo] failed to migrate network-preferences.json', error)
  )

  // Applied before the window is created so the initial background/icon already match —
  // the saved preference otherwise only takes effect on the next 'updated' event.
  nativeTheme.themeSource = await loadThemeSource()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  downloadManager = registerIpcHandlers(() => mainWindow)

  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff')
  })

  if (is.dev) installDevMenu()

  createWindow()
  if (testKnobs.hideWindow) app.dock?.hide()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (quitAfterSuspending || !downloadManager) return

  event.preventDefault()

  // Guarantee the process exits even if suspending hangs
  const forceQuitTimeout = setTimeout(() => {
    app.exit(0)
  }, 3000)

  void downloadManager.suspendAll().finally(() => {
    clearTimeout(forceQuitTimeout)
    quitAfterSuspending = true
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
