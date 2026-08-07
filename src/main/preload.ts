import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Minimal, safe IPC surface exposed to renderer via preload when contextIsolation is enabled.
// Provides on/off/send/invoke wrappers used by the renderer. Keeps the real ipcRenderer
// out of the global scope to reduce attack surface.


const novaIpc = {
  on(channel: string, listener: (payload: any) => void) {
    const wrapped = (_event: IpcRendererEvent, payloadArg: any) => listener(payloadArg);
    // Store wrapper so removeListener can work (renderer should pass same function reference to off)
    (novaIpc as any)[`__handler_${channel}_${String(listener)}`] = wrapped;
    ipcRenderer.on(channel, wrapped);
  },
  removeListener(channel: string, listener: (payload: any) => void) {
    const wrapped = (novaIpc as any)[`__handler_${channel}_${String(listener)}`];
    if (wrapped) {
      ipcRenderer.removeListener(channel, wrapped);
      delete (novaIpc as any)[`__handler_${channel}_${String(listener)}`];
    }
  },
  send(channel: string, ...args: any[]) {
    ipcRenderer.send(channel, ...args);
  },
  invoke(channel: string, ...args: any[]) {
    return ipcRenderer.invoke(channel, ...args);
  },
  // convenience for binary audio chunks
  sendBinary(channel: string, buffer: Uint8Array) {
    ipcRenderer.send(channel, buffer);
  },
};

contextBridge.exposeInMainWorld('__nova_ipc__', novaIpc);
contextBridge.exposeInMainWorld('__is_electron__', true);

export {};
