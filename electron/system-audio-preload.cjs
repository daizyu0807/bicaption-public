const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__systemAudio', {
  sendPCM: (arrayBuffer) => {
    ipcRenderer.send('system-audio:pcm-chunk', arrayBuffer);
  },
  sendReady: (sampleRate) => {
    ipcRenderer.send('system-audio:ready', sampleRate);
  },
  sendError: (message) => {
    ipcRenderer.send('system-audio:error', message);
  },
});
