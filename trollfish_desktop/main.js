'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');

const RENDERER_DIR = path.join(__dirname, 'renderer');

// Must run before app 'ready'. Marks our scheme as privileged so net.fetch,
// streaming and HTTP range requests (video seeking) work, and CSP is bypassed.
protocol.registerSchemesAsPrivileged([
  // Serves the renderer from a real, secure origin (app://local/...) so ES
  // modules, query strings, IndexedDB and secure-context APIs behave like a
  // normal website — file:// is too restrictive and yields a blank window.
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, allowServiceWorkers: false },
  },
  {
    scheme: 'trollfish-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.wasm': 'application/wasm',
  '.stl': 'application/octet-stream', '.onnx': 'application/octet-stream',
  '.map': 'application/json', '.webmanifest': 'application/manifest+json',
};

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#f5f6f8',
    title: 'TrollFish',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Renderer streams large local video files; allow it to fetch via the
      // privileged trollfish-file:// protocol registered below.
      webSecurity: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadURL('app://local/index.html');

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Custom protocol: stream native files into <video> efficiently ────────
// Instead of copying multi-GB GoPro videos into evictable browser storage
// (the macOS/Safari OPFS bug this desktop edition fixes), the renderer keeps
// the absolute disk path and plays the file via trollfish-file://<encoded-path>.
// Electron's net.fetch streams it with HTTP range support, so seeking works.
function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    // Strip query/hash; resolve within RENDERER_DIR (no path traversal).
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const abs = path.normalize(path.join(RENDERER_DIR, rel));
    if (!abs.startsWith(RENDERER_DIR)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fsp.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          // Enable crossOriginIsolated so ONNX Runtime can use multithreaded
          // (SharedArrayBuffer) WASM. 'credentialless' still allows no-cors CDN
          // fetches (MediaPipe, onnxruntime-web) without CORP headers on them.
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function registerFileProtocol() {
  protocol.handle('trollfish-file', async (request) => {
    const url = new URL(request.url);
    // host + pathname together hold the percent-encoded absolute path.
    const encoded = url.pathname.replace(/^\/+/, '');
    let filePath;
    try {
      filePath = decodeURIComponent(encoded);
    } catch {
      return new Response('Bad path', { status: 400 });
    }
    // Serve the file ourselves with explicit Range handling. net.fetch of
    // file:// proved unreliable under concurrent video loads on Windows.
    let st;
    try {
      st = await fsp.stat(filePath);
    } catch (e) {
      console.error('[trollfish-file] stat failed:', filePath, e.message);
      return new Response('Not found', { status: 404 });
    }
    const total = st.size;
    const range = request.headers.get('Range') || request.headers.get('range');
    const ext = path.extname(filePath).toLowerCase();
    const ctype = MIME[ext] || 'video/mp4';

    let start = 0;
    let end = total - 1;
    let status = 200;
    const headers = {
      'Content-Type': ctype,
      'Accept-Ranges': 'bytes',
      // Allow this cross-scheme video to load under COEP cross-origin isolation.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1]) start = parseInt(m[1], 10);
        if (m[2]) end = parseInt(m[2], 10);
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= total) end = total - 1;
        if (start > end) start = 0;
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      }
    }
    headers['Content-Length'] = String(end - start + 1);

    const nodeStream = fs.createReadStream(filePath, { start, end });
    const webStream = Readable.toWeb(nodeStream);
    return new Response(webStream, { status, headers });
  });
}

app.whenReady().then(() => {
  registerAppProtocol();
  registerFileProtocol();
  createWindow();
  // Open DevTools so any renderer error is visible during bring-up.
  if (mainWindow) mainWindow.webContents.openDevTools({ mode: 'detach' });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: native file picker (returns real absolute paths + metadata) ─────
ipcMain.handle('tf:pickFiles', async (_evt, opts = {}) => {
  const filters = opts.filters || [
    { name: 'Session files', extensions: ['mp4', 'mov', 'm4v', 'csv', 'gpx'] },
    { name: 'All files', extensions: ['*'] },
  ];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: opts.title || 'Add session files',
    properties: ['openFile', 'multiSelections'],
    filters,
  });
  if (result.canceled) return [];
  const out = [];
  for (const p of result.filePaths) {
    try {
      const st = await fsp.stat(p);
      out.push({
        path: p,
        name: path.basename(p),
        size: st.size,
        lastModified: st.mtimeMs,
        url: 'trollfish-file://local/' + encodeURIComponent(p),
      });
    } catch { /* skip unreadable */ }
  }
  return out;
});

// ── IPC: read a file's bytes by absolute path (for CSV / GPS extraction) ──
ipcMain.handle('tf:readFile', async (_evt, filePath) => {
  const buf = await fsp.readFile(filePath);
  // Return an ArrayBuffer slice for the structured clone boundary.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// ── Open-FD cache: avoid reopening the file for every range read ─────────
// GoPro GPS extraction issues many sequential range reads against the same
// file. Keeping the descriptor open removes an open()/close() syscall pair
// per read — the main per-read cost on desktop.
const _fdCache = new Map(); // filePath -> { fh, timer }
const FD_IDLE_MS = 15000;

async function getCachedFd(filePath) {
  let entry = _fdCache.get(filePath);
  if (!entry) {
    const fh = await fsp.open(filePath, 'r');
    entry = { fh, timer: null };
    _fdCache.set(filePath, entry);
  }
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    _fdCache.delete(filePath);
    entry.fh.close().catch(() => {});
  }, FD_IDLE_MS);
  return entry.fh;
}

// ── IPC: read a byte range by absolute path (lazy File.slice backing) ─────
ipcMain.handle('tf:readFileRange', async (_evt, filePath, start, end) => {
  // Use full-precision numbers — GoPro offsets exceed 2^31 (avoid |0 truncation).
  const safeStart = Math.max(0, Math.floor(Number(start) || 0));
  const length = Math.max(0, Math.floor(Number(end) || 0) - safeStart);
  const buf = Buffer.alloc(length);
  if (length > 0) {
    const fh = await getCachedFd(filePath);
    await fh.read(buf, 0, length, safeStart);
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// ── IPC: check a path still exists (next-day reopen) ─────────────────────
ipcMain.handle('tf:fileExists', async (_evt, filePath) => {
  try {
    await fsp.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
});

// ── IPC: stat a path (name/size/lastModified for re-pick matching) ───────
ipcMain.handle('tf:statFile', async (_evt, filePath) => {
  try {
    const st = await fsp.stat(filePath);
    return { path: filePath, name: path.basename(filePath), size: st.size, lastModified: st.mtimeMs };
  } catch {
    return null;
  }
});
