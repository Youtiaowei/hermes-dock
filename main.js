const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('disable-gpu-cache');

let statusWindow;

// Lazy-loaded modules (sql.js = pure JS, no native compilation needed)
let initSqlJs = null;
let yaml = null;

function getHermesHome() {
  return process.env.HERMES_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.hermes');
}

function getGatewayStatePath() {
  return path.join(getHermesHome(), 'gateway_state.json');
}

function getLiveStatusPath() {
  return path.join(getHermesHome(), 'live_status.json');
}

function getStateDbPath() {
  return path.join(getHermesHome(), 'state.db');
}

function getConfigYamlPath() {
  return path.join(getHermesHome(), 'config.yaml');
}

function getSettingsPath() {
  return path.join(getHermesHome(), 'hermes-dock-settings.json');
}

function readGatewayState() {
  try {
    const statePath = getGatewayStatePath();
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (err) {}
  return null;
}

function readLiveStatus() {
  try {
    const statusPath = getLiveStatusPath();
    if (fs.existsSync(statusPath)) {
      const data = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      if (data.timestamp && (Date.now() / 1000 - data.timestamp) < 5) {
        return data;
      }
    }
  } catch (err) {}
  return null;
}

function isGatewayAlive() {
  try {
    const state = readGatewayState();
    if (state && state.pid) {
      try {
        process.kill(state.pid, 0);
        return true;
      } catch (e) {
        return false;
      }
    }
  } catch (err) {}
  return false;
}

// ============================================================
//  DATA PANEL: Read state.db for token usage statistics
//  Uses sql.js (pure JavaScript SQLite) - NO native compilation
// ============================================================

let _sqlDb = null;
let _sqlDbMtime = 0;

function ensureSqlJs() {
  if (!initSqlJs) {
    try {
      initSqlJs = require('sql.js');
    } catch (e) {
      console.error('[hermes-dock] sql.js not available. Run: npm install');
      return null;
    }
  }
  return initSqlJs;
}

async function getSqlDb() {
  const SQL = ensureSqlJs();
  if (!SQL) return null;

  const dbPath = getStateDbPath();
  if (!fs.existsSync(dbPath)) return null;

  try {
    // Check if file changed since last load
    const stat = fs.statSync(dbPath);
    const mtime = stat.mtimeMs;
    if (_sqlDb && _sqlDbMtime === mtime) {
      return _sqlDb;
    }

    const fileBuffer = fs.readFileSync(dbPath);
    const arrayBuffer = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength
    );
    const sqlInit = await initSqlJs({
      locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
    });
    const db = new sqlInit.Database(new Uint8Array(arrayBuffer));
    _sqlDb = db;
    _sqlDbMtime = mtime;
    return db;
  } catch (err) {
    console.error('[hermes-dock] Error loading state.db:', err.message); try { fs.writeFileSync(path.join(os.tmpdir(), 'hermes-dock.log'), '[' + new Date().toISOString() + '] ERROR loading state.db: ' + err.message + ' ' + err.stack + '\n', {flag:'a'}); } catch(e) {}
    return null;
  }
}

function formatTokenCount(n) {
  if (!n || n === 0) return '0';
  var num = Math.floor(Number(n));
  if (num === 0) return '0';
  var str = num.toString();
  var result = '';
  var cnt = 0;
  for (var i = str.length - 1; i >= 0; i--) {
    result = str[i] + result;
    cnt++;
    if (cnt % 3 === 0 && i > 0 && str[i-1] !== '-') { result = ',' + result; }
  }
  return result;
}

async function readTokenStats() {
  const db = await getSqlDb();
  if (!db) return null;

  try {
    // Calculate today's start (midnight local time) as Unix timestamp
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000;

    // Daily tokens
    const dailyResult = db.exec(`
      SELECT COALESCE(SUM(input_tokens + output_tokens + reasoning_tokens), 0) as total
      FROM sessions WHERE started_at >= ${todayStart}
    `);
    const dailyTokens = dailyResult.length > 0 ? dailyResult[0].values[0][0] : 0;

    // Monthly tokens
    const monthlyResult = db.exec(`
      SELECT COALESCE(SUM(input_tokens + output_tokens + reasoning_tokens), 0) as total
      FROM sessions WHERE started_at >= ${monthStart}
    `);
    const monthlyTokens = monthlyResult.length > 0 ? monthlyResult[0].values[0][0] : 0;

    // Active sessions today
    const activeResult = db.exec(`
      SELECT COUNT(*) as count FROM sessions WHERE started_at >= ${todayStart}
    `);
    const activeSessions = activeResult.length > 0 ? activeResult[0].values[0][0] : 0;

    return {
      dailyTokens,
      monthlyTokens,
      activeSessions,
      dailyFormatted: formatTokenCount(dailyTokens),
      monthlyFormatted: formatTokenCount(monthlyTokens)
    };
  } catch (err) {
    console.error('[hermes-dock] Error reading state.db:', err.message);
    return null;
  }
}

// ============================================================
//  DATA PANEL: Read config.yaml for model name
// ============================================================

function ensureYaml() {
  if (!yaml) {
    try {
      yaml = require('js-yaml');
    } catch (e) {
      console.error('[hermes-dock] js-yaml not available. Run: npm install');
      return null;
    }
  }
  return yaml;
}

function readModelName() {
  const yamlLib = ensureYaml();
  const configPath = getConfigYamlPath();

  if (!yamlLib || !fs.existsSync(configPath)) {
    // Fallback: simple line parsing
    return readModelNameFallback();
  }

  try {
    const config = yamlLib.load(fs.readFileSync(configPath, 'utf8'));
    if (config && config.model && config.model.default) {
      return config.model.default;
    }
  } catch (err) {
    console.error('[hermes-dock] Error parsing config.yaml:', err.message);
    return readModelNameFallback();
  }
  return 'unknown';
}

function readModelNameFallback() {
  try {
    const configPath = getConfigYamlPath();
    if (!fs.existsSync(configPath)) return 'unknown';
    const content = fs.readFileSync(configPath, 'utf8');
    // Simple regex to find model.default value
    const match = content.match(/^model:\s*\n\s*default:\s*(.+)$/m);
    if (match) return match[1].trim();
    return 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

// ============================================================
//  SETTINGS: Read/write hermes-dock-settings.json
// ============================================================

const defaultSettings = {
  language: 'zh',
  theme: 'dark',
  autoStart: false
};

function readSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return { ...defaultSettings, ...data };
    }
  } catch (err) {
    console.error('[hermes-dock] Error reading settings:', err.message);
  }
  return { ...defaultSettings };
}

function saveSettings(newSettings) {
  try {
    const settingsPath = getSettingsPath();
    const current = readSettings();
    const merged = { ...current, ...newSettings };
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
    return { success: true, settings: merged };
  } catch (err) {
    console.error('[hermes-dock] Error saving settings:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================
//  IPC HANDLERS
// ============================================================

ipcMain.handle('get-hermes-data', async () => {
    try { fs.writeFileSync(path.join(os.tmpdir(), 'hermes-dock.log'), '[' + new Date().toISOString() + '] get-hermes-data called\n', {flag:'a'}); } catch(e) {}
  let tokenStats = null;
    try {
      tokenStats = await readTokenStats();
      try { fs.writeFileSync(path.join(os.tmpdir(), 'hermes-dock.log'), '[' + new Date().toISOString() + '] readTokenStats done: ' + JSON.stringify(tokenStats ? {daily: tokenStats.dailyTokens, monthly: tokenStats.monthlyTokens} : null) + '\n', {flag:'a'}); } catch(e) {}
    } catch(e) {
      try { fs.writeFileSync(path.join(os.tmpdir(), 'hermes-dock.log'), '[' + new Date().toISOString() + '] readTokenStats EXCEPTION: ' + e.message + '\n', {flag:'a'}); } catch(x) {}
    }
  const modelName = readModelName();
  const liveStatus = readLiveStatus();
  const gatewayState = readGatewayState();

  return {
    dailyTokens: tokenStats ? tokenStats.dailyTokens : 0,
    dailyFormatted: tokenStats ? tokenStats.dailyFormatted : '0',
    monthlyTokens: tokenStats ? tokenStats.monthlyTokens : 0,
    monthlyFormatted: tokenStats ? tokenStats.monthlyFormatted : '0',
    activeSessions: tokenStats ? tokenStats.activeSessions : 0,
    model: modelName,
    processing: {
      active: liveStatus ? liveStatus.active : false,
      message: liveStatus ? (liveStatus.message || '') : '',
      elapsed: liveStatus ? (liveStatus.elapsed || 0) : 0
    },
    activeAgents: (gatewayState && gatewayState.active_agents) ? gatewayState.active_agents : 0
  };
});

ipcMain.handle('get-settings', () => {
  return readSettings();
});

ipcMain.handle('save-settings', (event, newSettings) => {
  return saveSettings(newSettings);
});

ipcMain.handle('set-auto-start', (event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: []
  });
  return { success: true, enabled };
});

// ============================================================
//  STATUS MANAGEMENT
// ============================================================

let currentStatus = {
  isOnline: false,
  isProcessing: false,
  processingInfo: null,
  platforms: {},
  lastUpdate: null
};

function updateStatus() {
  const state = readGatewayState();
  const alive = isGatewayAlive();
  const liveStatus = readLiveStatus();
  
  if (state) {
    const isRunning = state.gateway_state === 'running' && alive;
    const hasConnected = Object.values(state.platforms || {}).some(p => p.state === 'connected');
    
    currentStatus.isOnline = isRunning && hasConnected;
    currentStatus.platforms = state.platforms || {};
    currentStatus.lastUpdate = new Date().toISOString();
    
    if (liveStatus && liveStatus.active) {
      currentStatus.isProcessing = true;
      currentStatus.processingInfo = {
        action: liveStatus.message || 'processing',
        time: liveStatus.elapsed ? liveStatus.elapsed.toString() : ''
      };
    } else {
      currentStatus.isProcessing = false;
      currentStatus.processingInfo = null;
    }
    
    if (statusWindow && !statusWindow.isDestroyed()) {
      statusWindow.webContents.send('status-update', currentStatus);
    }
  }
}

function createStatusWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  
  statusWindow = new BrowserWindow({
    width: 80,
    height: 80,  // Start collapsed (circle only) — animateResize expands on user interaction
    x: width - 100,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  statusWindow.loadFile('src/index.html');
  
  updateStatus();
  setInterval(updateStatus, 500);

  // NOTE: setIgnoreMouseEvents is intentionally NOT called here.
  // On Windows, setIgnoreMouseEvents(true) on transparent windows
  // causes the entire window to disappear when the mouse approaches.
  // Without click-through, transparent areas still capture mouse events
  // but have no visible UI elements — clicking them does nothing.
  // Users can right-click the island to close the dock.
}

// EaseOutBack easing function for bouncy animation
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
  
  
}

let resizeAnimation = null;

function animateResize(targetWidth, targetHeight, duration) {
  if (!statusWindow || statusWindow.isDestroyed()) return;
  if (duration === undefined) duration = 350;

  if (resizeAnimation) {
    clearTimeout(resizeAnimation);
    resizeAnimation = null;
  }

  const startBounds = statusWindow.getBounds();
  const startWidth = startBounds.width;
  const startHeight = startBounds.height;
  const startTime = Date.now();
  const startX = startBounds.x;

  function step() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(progress);

    const currentWidth = Math.round(startWidth + (targetWidth - startWidth) * eased);
    const currentHeight = Math.round(startHeight + (targetHeight - startHeight) * eased);
    const newX = startX;

    if (statusWindow && !statusWindow.isDestroyed()) {
      statusWindow.setBounds({
        x: newX,
        y: startBounds.y,
        width: currentWidth,
        height: currentHeight
      });
    }

    if (progress < 1) {
      resizeAnimation = setTimeout(step, 16);
    } else {
      resizeAnimation = null;
    }
  }

  step();
}

ipcMain.handle('resize-window', (event, width, height) => {
  animateResize(width, height);
});

app.whenReady().then(() => {
  createStatusWindow();
  // Apply saved auto-start setting
  const settings = readSettings();
  if (settings.autoStart) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: []
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createStatusWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-status', () => currentStatus);

// ============================================================
//  DRAG - DIP offset, setBounds
// ============================================================

function screenToDip(screenX, screenY) {
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const bx = d.bounds.x;
    const by = d.bounds.y;
    const bw = d.bounds.width;
    const bh = d.bounds.height;
    if (screenX >= bx && screenX < bx + bw && screenY >= by && screenY < by + bh) {
      const sf = d.scaleFactor;
      return {
        x: (screenX - bx) / sf + bx,
        y: (screenY - by) / sf + by
      };
    }
  }
  const primary = screen.getPrimaryDisplay();
  return {
    x: (screenX - primary.bounds.x) / primary.scaleFactor + primary.bounds.x,
    y: (screenY - primary.bounds.y) / primary.scaleFactor + primary.bounds.y
  };
}

let dragState = null;

ipcMain.on('start-drag', (event, cursorScreenX, cursorScreenY) => {
  if (!statusWindow || statusWindow.isDestroyed()) return;
  
  const bounds = statusWindow.getBounds();
  
  dragState = {
    offsetX: cursorScreenX - bounds.x,
    offsetY: cursorScreenY - bounds.y,
    width: bounds.width,
    height: bounds.height
  };
});

ipcMain.on('move-window', (event, cursorScreenX, cursorScreenY) => {
  if (!statusWindow || statusWindow.isDestroyed() || !dragState) return;
  
  const newX = Math.round(cursorScreenX - dragState.offsetX);
  const newY = Math.round(cursorScreenY - dragState.offsetY);
  
  try {
    statusWindow.setBounds({
      x: newX,
      y: newY,
      width: dragState.width,
      height: dragState.height
    });
  } catch (e) {}
});

ipcMain.on('stop-drag', () => {
  dragState = null;
});

ipcMain.on('close-window', () => {
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.close();
});

ipcMain.on('open-gateway', () => {
  const gatewayPath = path.join(process.env.USERPROFILE || process.env.HOME, 'Desktop', '启动网关(自动重启).bat');
  // Run gateway in background without showing a terminal window
  const { spawn } = require('child_process');
  spawn('cmd.exe', ['/c', gatewayPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref();
});
