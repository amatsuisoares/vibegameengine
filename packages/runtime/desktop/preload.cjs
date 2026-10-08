// Gives the player its save backend (window.__vibeSaveBackend): files in the user's data folder,
// through the main process (main.cjs).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__vibeSaveBackend', {
  get: async (key) => ipcRenderer.sendSync('save:get', key),
  set: async (key, value) => {
    const error = ipcRenderer.sendSync('save:set', key, value);
    if (error) throw new Error(error);
  },
  remove: async (key) => {
    ipcRenderer.sendSync('save:remove', key);
  },
});
