const { app, BrowserWindow, ipcMain, screen, clipboard, session, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");
const http = require("http");

let mainWindow;
let splashWindow;
let pyProcess;

const PORT = 5577;

function waitForServer(callback, retries = 30) {
  http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
    callback();
  }).on("error", () => {
    if (retries > 0) setTimeout(() => waitForServer(callback, retries - 1), 1000);
  });
}

function startPython() {
  const isPackaged = app.isPackaged;

  let pyBin, pyArgs;

  if (isPackaged) {
    // 패키징된 경우 → app.exe 단독 실행 (인수 없음)
    pyBin = path.join(process.resourcesPath, "server", "app.exe");
    pyArgs = [];
  } else {
    // 개발 모드 → python으로 app.py 실행
    pyBin = "python";
    pyArgs = [path.join(__dirname, "server", "app.py")];
  }

  pyProcess = spawn(pyBin, pyArgs, {
    env: { ...process.env, PORT: String(PORT), ELECTRON: "1" },
    stdio: "pipe",
  });
  pyProcess.stdout.on("data", (d) => console.log("[py]", d.toString().trim()));
  pyProcess.stderr.on("data", (d) => console.error("[py-err]", d.toString().trim()));
}

// app.exe(서버)가 자식으로 띄운 whisper-cli.exe/llama-completion.exe/ffmpeg.exe 등은
// pyProcess.kill()만으로는 안 죽고 고아 프로세스로 남는다(부모만 죽고 자식은 그대로 실행 계속).
// Windows에서는 taskkill /T(트리 전체) /F(강제)로 자식까지 통째로 종료해야 한다.
function killServerTree() {
  if (!pyProcess || !pyProcess.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pyProcess.pid), "/T", "/F"]);
    } catch (e) {
      // 이미 종료됐거나 taskkill 실패 시에도 최소한 부모는 마저 종료 시도
      try { pyProcess.kill(); } catch {}
    }
  } else {
    try { pyProcess.kill(); } catch {}
  }
  pyProcess = null;
}

function createSplashWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  splashWindow = new BrowserWindow({
    width, height,
    frame: false,
    transparent: false,
    resizable: false,
    center: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    backgroundColor: "#ddd9d1",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.maximize();
  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  splashWindow.once("ready-to-show", () => splashWindow.show());
}

function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width, height,
    minWidth: 900, minHeight: 600,
    frame: false,
    transparent: false,
    show: false,
    opacity: 0,
    backgroundColor: "#f7f5f2",
    icon: path.join(__dirname, "src", "assets", "gongulbaki-icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.maximize();
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  // 브라우저 기본 줌(Ctrl+휠, Ctrl+±) 전체 비활성화
  mainWindow.webContents.setZoomFactor(1);
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);

  mainWindow.webContents.once("did-finish-load", () => {
    // 메인창 보이게 하고 페이드인 시작
    mainWindow.show();
    mainWindow.focus();
    // opacity 0→1 페이드인 (60fps, 1.1초)
    let opacity = 0;
    const fadeIn = setInterval(() => {
      opacity = Math.min(1, opacity + 1 / 66);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setOpacity(opacity);
      if (opacity >= 1) clearInterval(fadeIn);
    }, 1000 / 60);

    // 스플래시에 페이드아웃 신호 전송
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send("start-fade");
      // 스플래시 페이드아웃(1.1초) 완료 후 닫기
      setTimeout(() => {
        if (splashWindow && !splashWindow.isDestroyed()) {
          splashWindow.close();
          splashWindow = null;
        }
      }, 1200);
    }
  });

  mainWindow.on("closed", () => { mainWindow = null; });

  // help.html 창 — 메뉴바 숨기기
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        menuBarVisible: false,
        width: 860,
        height: 700,
        center: true,
        icon: path.join(__dirname, "src", "assets", "gongulbaki-icon.ico"),
      },
    };
  });
  mainWindow.on("maximize", () => mainWindow && mainWindow.webContents.send("window-state-changed", "maximized"));
  mainWindow.on("unmaximize", () => mainWindow && mainWindow.webContents.send("window-state-changed", "normal"));
}



ipcMain.on("window-minimize", () => mainWindow?.minimize());
ipcMain.on("window-maximize", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});

// 창 닫기: 렌더러에 종료 확인 요청
ipcMain.on("window-close", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app-close-requested");
  }
});

// 렌더러가 "종료 확인" 응답 → 실제 종료
ipcMain.on("close-confirmed", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeAllListeners("close");
    killServerTree();
    mainWindow.destroy();
  }
});

// 렌더러가 "취소" 응답 → 아무것도 안 함
ipcMain.on("close-cancelled", () => {});

ipcMain.handle("window-is-maximized", () => mainWindow?.isMaximized() ?? false);
ipcMain.handle("clipboard-write", (_, text) => {
  const str = String(text || "");
  clipboard.writeText(str);
  return clipboard.readText().length; // 실제로 써졌는지 확인용
});

// ── 사례서랍: 이미 있는 파일을 "연결"만 함(복사 X, 경로만 저장) ──────────
// 사례 정리정보(기본정보·회차구성 등 앱에서 직접 입력하는 내용)는 사용자가 지정한
// 폴더 안에 실제 파일(_사례정보.json)로 저장 — 앱을 지워도 그 폴더만 있으면 복구됨.
// 앱 전용 저장공간(userData)에는 "어느 폴더를 쓰는지"와 "앱 잠금 비밀번호 해시"만 남긴다.
const CASE_SETTINGS_PATH = path.join(app.getPath("userData"), "case-drawer-settings.json");

ipcMain.handle("case-settings-get", () => {
  try {
    return JSON.parse(fs.readFileSync(CASE_SETTINGS_PATH, "utf-8"));
  } catch {
    return { rootFolder: null, passwordHash: null, passwordSalt: null };
  }
});

ipcMain.handle("case-settings-set", (_, data) => {
  try {
    fs.mkdirSync(path.dirname(CASE_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(CASE_SETTINGS_PATH, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("case-select-folder", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle("case-list-dirs", (_, rootPath) => {
  try {
    return fs.readdirSync(rootPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
});

ipcMain.handle("case-mkdir", (_, dirPath) => {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("case-write-text", (_, filePath, content) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("case-select-file", async (_, filters) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: filters || [{ name: "모든 파일", extensions: ["*"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle("case-read-text", (_, filePath) => {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
});

// PDF·워드 미리보기용 — 렌더러(화면)에서 fetch("file://...")로 로컬 파일을 직접 읽으려 하면
// Chromium의 webSecurity가 차단한다. 대신 메인 프로세스(Node, 제약 없음)가 파일을 읽어서
// base64로 건네준다.
ipcMain.handle("case-read-binary", (_, filePath) => {
  try {
    return fs.readFileSync(filePath).toString("base64");
  } catch {
    return null;
  }
});

ipcMain.handle("case-file-exists", (_, filePath) => {
  try { return fs.existsSync(filePath); } catch { return false; }
});

ipcMain.handle("case-open-external", (_, filePath) => {
  shell.openPath(filePath);
  return true;
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => {
    callback(["clipboard-read", "clipboard-sanitized-write", "clipboard-write"].includes(permission));
  });
  startPython();
  createSplashWindow();
  // 서버 준비 완료 → 스플래시에 모델 다운로드 시작 신호
  waitForServer(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send("start-download");
    }
  });
});

// 스플래시에서 모델 다운로드 완료 신호 수신 → 메인창 열기
ipcMain.on("models-ready", () => {
  createMainWindow();
});

app.on("window-all-closed", () => {
  killServerTree();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) createMainWindow();
});
