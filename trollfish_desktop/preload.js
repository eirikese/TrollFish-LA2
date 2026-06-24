'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Exposes a minimal, durable native-file bridge to the renderer.
// The renderer's file-manager.js detects window.trollfishDesktop and, when
// present, persists absolute disk paths instead of copying GoPro blobs into
// evictable OPFS storage — which is what breaks next-day reloads on macOS.
contextBridge.exposeInMainWorld('trollfishDesktop', {
  isDesktop: true,
  platform: process.platform,

  /** Native multi-select file picker. Returns [{path,name,size,lastModified,url}]. */
  pickFiles: (opts) => ipcRenderer.invoke('tf:pickFiles', opts),

  /** Read a file's bytes by absolute path → ArrayBuffer (CSV / GPS extraction). */
  readFile: (filePath) => ipcRenderer.invoke('tf:readFile', filePath),

  /** Read a byte range [start,end) by absolute path → ArrayBuffer (lazy slice). */
  readFileRange: (filePath, start, end) => ipcRenderer.invoke('tf:readFileRange', filePath, start, end),

  /** True if the absolute path is still readable (next-day reopen check). */
  fileExists: (filePath) => ipcRenderer.invoke('tf:fileExists', filePath),

  /** Stat a path → {path,name,size,lastModified} or null. */
  statFile: (filePath) => ipcRenderer.invoke('tf:statFile', filePath),
});
