// Electron main process of an exported game (`vibe package desktop`). Plain CommonJS: Electron runs it
// as is, next to game.json (name, title, size) and web/ (the `vibe export` folder).
const { app, BrowserWindow, Menu, ipcMain, protocol, net, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const game = JSON.parse(fs.readFileSync(path.join(__dirname, 'game.json'), 'utf8'));
const WEB = path.join(__dirname, 'web');

// Tests run with their own data folder (a fresh "computer").
if (process.env.VIBE_USER_DATA) app.setPath('userData', process.env.VIBE_USER_DATA);

// The page is served from app://game/ (not file://) so it has a real origin: module scripts and
// fetch() of the sounds work as on a web server.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
// Only the app's own files, no network. 'unsafe-eval': game scripts are compiled with new Function.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:";

// --- Save: one JSON file per key in <userData>/save, written atomically (tmp + rename) ---
const SAVE_DIR = () => path.join(app.getPath('userData'), 'save');
const fileOf = (key) => path.join(SAVE_DIR(), `${encodeURIComponent(key)}.json`);
ipcMain.on('save:get', (e, key) => {
  try {
    e.returnValue = fs.readFileSync(fileOf(key), 'utf8');
  } catch {
    e.returnValue = null;
  }
});
// Synchronous on purpose: the last write when the window closes (pagehide) must land before exit.
ipcMain.on('save:set', (e, key, value) => {
  try {
    fs.mkdirSync(SAVE_DIR(), { recursive: true });
    const tmp = `${fileOf(key)}.tmp`;
    fs.writeFileSync(tmp, value);
    fs.renameSync(tmp, fileOf(key));
    e.returnValue = null;
  } catch (err) {
    e.returnValue = String(err && err.message ? err.message : err);
  }
});
ipcMain.on('save:remove', (e, key) => {
  fs.rmSync(fileOf(key), { force: true });
  e.returnValue = null;
});

function createWindow() {
  const win = new BrowserWindow({
    title: game.title,
    width: game.width,
    height: game.height,
    useContentSize: true,
    minWidth: 320,
    minHeight: 180,
    backgroundColor: '#000000',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  // Links never open inside the game window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://game/')) e.preventDefault();
  });
  // F11: full screen; Esc leaves it.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    } else if (input.key === 'Escape' && win.isFullScreen()) win.setFullScreen(false);
  });
  void win.loadURL('app://game/index.html');
}

// One copy at a time: two windows would overwrite each other's save.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    protocol.handle('app', async (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
      const file = path.normalize(path.join(WEB, rel || 'index.html'));
      if (!file.startsWith(WEB + path.sep)) return new Response('Not found', { status: 404 });
      const res = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      return new Response(res.body, { status: res.status, headers });
    });
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
