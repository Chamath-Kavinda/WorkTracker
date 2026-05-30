const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } = require('electron');
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

// Initialize data files
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { tasks: [], sessions: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { tasks: [], sessions: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    const defaults = { startWithWindows: false, theme: 'dark', firebaseConfig: null };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { startWithWindows: false, theme: 'dark', firebaseConfig: null };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let mainWindow;
let tray;

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
  //mainWindow.webContents.openDevTools();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  // Create a simple tray icon programmatically
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

app.on('window-all-closed', () => {
  // Keep app running in tray
});

app.on('before-quit', () => {
  mainWindow.removeAllListeners('close');
});

// IPC Handlers
ipcMain.handle('load-data', () => loadData());
ipcMain.handle('save-data', (_, data) => { saveData(data); return true; });
ipcMain.handle('load-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, settings) => {
  saveSettings(settings);
  // Handle startup with Windows
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
  if (isPdf) {
    fs.writeFileSync(filepath, Buffer.from(content, 'base64'));
  } else {
    fs.writeFileSync(filepath, content, 'utf8');
  }
  return filepath;
});

ipcMain.handle('open-exports-folder', (_, folder) => {
  const subFolder = folder || 'Reports';
  const exportsPath = path.join(app.getPath('userData'), 'exports', subFolder);
  if (!fs.existsSync(exportsPath)) fs.mkdirSync(exportsPath, { recursive: true });
  shell.openPath(exportsPath);
});

ipcMain.handle('get-app-start-time', () => APP_START_TIME);
