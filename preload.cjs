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
  clipboardWrite: (text) => ipcRenderer.invoke("clipboard-write", text),
});

// 사례서랍: 기존 파일을 경로로만 연결(복사 X). 정리정보(기본정보·회차구성)는
// 사용자가 지정한 폴더 안에 실제 파일로 저장 — 앱 저장공간엔 폴더 위치·잠금 비번 해시만 둔다.
contextBridge.exposeInMainWorld("caseDrawerAPI", {
  getSettings: () => ipcRenderer.invoke("case-settings-get"),
  setSettings: (data) => ipcRenderer.invoke("case-settings-set", data),
  selectFolder:() => ipcRenderer.invoke("case-select-folder"),
  listDirs:    (rootPath) => ipcRenderer.invoke("case-list-dirs", rootPath),
  mkdir:       (dirPath) => ipcRenderer.invoke("case-mkdir", dirPath),
  writeText:   (filePath, content) => ipcRenderer.invoke("case-write-text", filePath, content),
  selectFile:  (filters) => ipcRenderer.invoke("case-select-file", filters),
  readText:    (filePath) => ipcRenderer.invoke("case-read-text", filePath),
  readBinary:  (filePath) => ipcRenderer.invoke("case-read-binary", filePath),
  fileExists:  (filePath) => ipcRenderer.invoke("case-file-exists", filePath),
  openExternal:(filePath) => ipcRenderer.invoke("case-open-external", filePath),
});
