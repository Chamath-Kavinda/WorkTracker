const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Data storage path
const DATA_DIR = path.join(app.getPath('userData'), 'worktracker');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const APP_START_TIME = new Date().toISOString();

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { tasks: [], sessions: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { tasks: [], sessions: [] }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    const defaults = { startWithWindows: false, theme: 'dark' };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { startWithWindows: false, theme: 'dark' }; }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let mainWindow;
let tray;
let _trayTickInterval = null;
let overlayWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: '#0f0f13',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    webSecurity: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools(); // DEV-ONLY: comment out in production

  mainWindow.once('ready-to-show', () => { mainWindow.show(); });
  mainWindow.on('close', (e) => { e.preventDefault(); mainWindow.hide(); });
}

function createOverlayWindow() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize; // workArea excludes taskbar

  overlayWindow = new BrowserWindow({
    width: 280,   // wider to fit full task name
    height: 52,   // taller for bigger font
    x: width - 290,   // 10px from right edge
    y: height - 62,   // 10px above taskbar
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWindow.loadFile('overlay.html');
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open WorkTracker', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); process.exit(0); } }
  ]);
  tray.setToolTip('WorkTracker');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow.show());
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.worktracker.app');
  createWindow();
  createTray();
});

app.on('window-all-closed', () => { /* keep in tray */ });
app.on('before-quit', () => { mainWindow.removeAllListeners('close'); });

// ── IPC Handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('load-data', () => loadData());
ipcMain.handle('save-data', (_, data) => { saveData(data); return true; });
ipcMain.handle('load-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, settings) => {
  saveSettings(settings);
  app.setLoginItemSettings({ openAtLogin: settings.startWithWindows });
  return true;
});
ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.hide());
ipcMain.handle('window-quit', () => { app.quit(); process.exit(0); });
ipcMain.handle('get-platform-info', () => ({
  homedir: os.homedir(),
  platform: os.platform(),
  username: os.userInfo().username,
}));
ipcMain.handle('export-report', (_, { content, filename, isPdf, folder }) => {
  const subFolder = folder || 'Reports';
  const docsPath = path.join(app.getPath('userData'), 'exports', subFolder);
  if (!fs.existsSync(docsPath)) fs.mkdirSync(docsPath, { recursive: true });
  const filepath = path.join(docsPath, filename);
  if (isPdf) fs.writeFileSync(filepath, Buffer.from(content, 'base64'));
  else fs.writeFileSync(filepath, content, 'utf8');
  return filepath;
});
ipcMain.handle('open-exports-folder', (_, folder) => {
  const subFolder = folder || 'Reports';
  const exportsPath = path.join(app.getPath('userData'), 'exports', subFolder);
  if (!fs.existsSync(exportsPath)) fs.mkdirSync(exportsPath, { recursive: true });
  shell.openPath(exportsPath);
});
ipcMain.handle('get-app-start-time', () => APP_START_TIME);

// ── Google Sign-In via System Browser + localhost redirect ────────────────────
// Opens the default browser (Chrome etc.) so the user sees their real saved
// Google accounts. A tiny local HTTP server catches the OAuth callback.
//
// ✅ Google Cloud Console → Authorized redirect URIs — add EXACTLY:
//      http://localhost:42831/auth
//
const http = require('http');
const AUTH_PORT = 42831; // Fixed port — must match Google Cloud Console entry

let _authServer = null; // keep reference so we can close stale servers

ipcMain.handle('google-sign-in', async () => {
  // Kill any leftover server from a previous failed attempt
  if (_authServer) {
    try { _authServer.close(); } catch (_) { }
    _authServer = null;
  }

  return new Promise((resolve, reject) => {
    const CLIENT_ID = '482821840009-bvqa4etj6v06rn9fjr6bvgrdt5oil8u6.apps.googleusercontent.com';
    const REDIRECT = `http://localhost:${AUTH_PORT}/auth`;

    // Start a one-shot local server on the fixed port
    const server = http.createServer();
    _authServer = server;
    server.listen(AUTH_PORT, '127.0.0.1', () => {

      const AUTH_URL =
        `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&response_type=token%20id_token` +
        `&scope=openid%20email%20profile` +
        `&nonce=${Math.random().toString(36).slice(2)}` +
        `&prompt=select_account`;

      // Auto-cancel after 5 minutes
      const timeout = setTimeout(() => {
        server.close();
        _authServer = null;
        reject(new Error('auth/popup-closed-by-user'));
      }, 5 * 60 * 1000);

      server.on('request', (req, res) => {
        const reqUrl = new URL(req.url, `http://localhost:${AUTH_PORT}`);

        // Google sends tokens in the hash fragment which the browser doesn't
        // forward to the server. We serve a tiny HTML page that reads the hash
        // and POSTs the tokens back to us using an absolute URL.
        if (reqUrl.pathname === '/auth' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html>
          <html>
          <head>
          <meta charset="utf-8">
          <title>Signing in to WorkTracker...</title>
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              background: #0f0f13;
              color: #fff;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              flex-direction: column;
              gap: 20px;
            }

            /* ── Spinner (shown while loading) ── */
            .spinner {
              width: 64px; height: 64px;
              border: 4px solid #2a2a35;
              border-top-color: #7c6af7;
              border-radius: 50%;
              animation: spin .8s linear infinite;
            }
            @keyframes spin { to { transform: rotate(360deg); } }

            /* ── Animated tick circle (shown on success) ── */
            .tick-wrap {
              display: none;
              width: 80px; height: 80px;
            }
            .tick-wrap svg { width: 80px; height: 80px; }

            .circle {
              fill: none;
              stroke: #7c6af7;
              stroke-width: 4;
              stroke-dasharray: 226;
              stroke-dashoffset: 226;
              stroke-linecap: round;
              animation: drawCircle .55s ease forwards;
            }
            @keyframes drawCircle {
              to { stroke-dashoffset: 0; }
            }

            .check {
              fill: none;
              stroke: #a78bfa;
              stroke-width: 4.5;
              stroke-linecap: round;
              stroke-linejoin: round;
              stroke-dasharray: 60;
              stroke-dashoffset: 60;
              animation: drawCheck .35s ease .5s forwards;
            }
            @keyframes drawCheck {
              to { stroke-dashoffset: 0; }
            }

            h2 { font-size: 20px; font-weight: 700; letter-spacing: -.3px; }
            p  { color: #888; font-size: 14px; }

            .error-icon { font-size: 56px; display: none; }
          </style>
          </head>
          <body>
            <div class="spinner"  id="spinner"></div>
            <div class="tick-wrap" id="tick">
              <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
                <circle class="circle" cx="40" cy="40" r="36"
                        transform="rotate(-90 40 40)"/>
                <polyline class="check" points="24,41 35,52 56,30"/>
              </svg>
            </div>
            <div class="error-icon" id="errIcon">&#9888;</div>
            <h2 id="title">Signing you in...</h2>
            <p  id="msg">Please wait a moment</p>

            <script>
              const TOKEN_URL = 'http://localhost:${AUTH_PORT}/token';
              const params = new URLSearchParams(
                location.hash.replace('#', '') || location.search.replace('?', '')
              );
              const access_token = params.get('access_token');
              const id_token     = params.get('id_token');
              const error        = params.get('error');

              fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token, id_token, error })
              }).then(r => {
                if (r.ok) {
                  document.getElementById('spinner').style.display = 'none';
                  document.getElementById('tick').style.display    = 'block';
                  document.getElementById('title').textContent     = 'Signed in successfully!';
                  document.getElementById('msg').textContent       = 'You can close this tab and return to WorkTracker.';
                }
              }).catch(() => {
                document.getElementById('spinner').style.display  = 'none';
                document.getElementById('errIcon').style.display  = 'block';
                document.getElementById('title').textContent      = 'Something went wrong';
                document.getElementById('msg').textContent        = 'Please return to WorkTracker and try again.';
              });
            </script>
          </body>
          </html>`);
          return;
        }

        // Receive the token POST from the page above
        if (reqUrl.pathname === '/token' && req.method === 'POST') {
          let body = '';
          req.on('data', d => { body += d; });
          req.on('end', () => {
            res.writeHead(200);
            res.end('ok');
            server.close();
            _authServer = null;
            clearTimeout(timeout);

            try {
              const { access_token, id_token, error } = JSON.parse(body);
              if (error) {
                reject(new Error(error));
              } else if (access_token || id_token) {
                // Bring WorkTracker back to the front
                if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
                resolve({ accessToken: access_token, idToken: id_token });
              } else {
                reject(new Error('No tokens received'));
              }
            } catch (e) {
              reject(e);
            }
          });
          return;
        }

        res.writeHead(404); res.end();
      });

      // Open the system browser — user sees their real Chrome accounts
      shell.openExternal(AUTH_URL);
    });

    server.on('error', (e) => {
      _authServer = null;
      if (e.code === 'EADDRINUSE') {
        reject(new Error('auth-port-busy'));
      } else {
        reject(new Error('Could not start local auth server: ' + e.message));
      }
    });
  });
});

ipcMain.handle('set-active-timer', (_, { taskName, startedAt }) => {
  if (_trayTickInterval) { clearInterval(_trayTickInterval); _trayTickInterval = null; }

  if (!taskName || !_trayTimerEnabled) {
    tray.setToolTip('WorkTracker');
    mainWindow.setTitle('WorkTracker');
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    return true;
  }

  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
  overlayWindow.show();

  const tick = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const hms = h > 0
      ? `${h}h ${String(m).padStart(2, '0')}m`
      : `${m}m ${String(s).padStart(2, '0')}s`;

    tray.setToolTip(`▶ ${taskName} — ${hms}`);
    mainWindow.setTitle(`WorkTracker ▶ ${taskName} ${hms}`);

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.executeJavaScript(`
        document.getElementById('task').textContent = ${JSON.stringify('▶ ' + taskName)};
        document.getElementById('time').textContent = ${JSON.stringify(hms)};
      `).catch(() => { });
    }
  };

  tick();
  _trayTickInterval = setInterval(tick, 1000);
  return true;
});

let _trayTimerEnabled = false; // default off, toggled via settings
ipcMain.handle('set-tray-timer-enabled', (_, enabled) => {
  _trayTimerEnabled = enabled;
  if (!enabled) {
    if (_trayTickInterval) { clearInterval(_trayTickInterval); _trayTickInterval = null; }
    tray.setToolTip('WorkTracker');
    mainWindow.setTitle('WorkTracker');
    // Hide overlay immediately
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  } else {
    // If a timer is currently running, restart the overlay
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`
        if (state.activeTaskId && state.activeSessionStart) {
          const task = state.tasks.find(t => t.id === state.activeTaskId);
          const existingMs = state.sessions
            .filter(s => s.taskId === state.activeTaskId)
            .reduce((a, s) => a + s.duration, 0);
          const virtualStart = state.activeSessionStart - existingMs;
          if (api.setActiveTimer) api.setActiveTimer({ taskName: task?.name, startedAt: virtualStart });
        }
      `).catch(() => { });
    }
  }
  return true;
});

ipcMain.handle('get-app-info', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  return {
    version: app.getVersion(),
    name: pkg.productName || pkg.name,
    description: pkg.description,
    author: typeof pkg.author === 'object' ? pkg.author.name : pkg.author,
  };
});

// ── Idle Detection ────────────────────────────────────────────────────────────
// Poll system idle time every 15 s and push events to the renderer.
// The renderer is responsible for comparing against the user's threshold.
ipcMain.handle('get-system-idle-time', () => {
  try { return powerMonitor.getSystemIdleTime(); }
  catch { return 0; }
});

let _idlePollInterval = null;

function startIdlePoll() {
  if (_idlePollInterval) return;
  _idlePollInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const idleSecs = powerMonitor.getSystemIdleTime();
      mainWindow.webContents.send('idle-tick', idleSecs);
    } catch { /* ignore */ }
  }, 5_000); // every 5 s is fine — threshold minimum is 3 min
}

app.whenReady().then(() => startIdlePoll());