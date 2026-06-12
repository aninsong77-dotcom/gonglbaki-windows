const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  minimize:    () => ipcRenderer.send("window-minimize"),
  maximize:    () => ipcRenderer.send("window-maximize"),
  close:       () => ipcRenderer.send("window-close"),
  isMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onWindowStateChanged: (cb) => ipcRenderer.on("window-state-changed", (_, state) => cb(state)),
  splashDone:  () => ipcRenderer.send("splash-done"),
  onStartFade: (cb) => ipcRenderer.on("start-fade", () => cb()),
  // 종료 확인 모달용
  onCloseRequested: (cb) => {
    ipcRenderer.on("app-close-requested", cb);
    return () => ipcRenderer.removeListener("app-close-requested", cb);
  },
  confirmClose: () => ipcRenderer.send("close-confirmed"),
  cancelClose:  () => ipcRenderer.send("close-cancelled"),
  // 모델 다운로드용
  onStartDownload: (cb) => ipcRenderer.on("start-download", () => cb()),
  modelsReady: () => ipcRenderer.send("models-ready"),
});
