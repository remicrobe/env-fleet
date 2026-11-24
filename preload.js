'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onTerm: (cb) => {
    ipcRenderer.on('term:event', (_e, msg) => cb(msg));
  },
  onExec: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on('exec:event', fn);
    return () => ipcRenderer.removeListener('exec:event', fn);
  },
});
