const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
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
    if (pyProcess) pyProcess.kill();
    mainWindow.destroy();
  }
});

// 렌더러가 "취소" 응답 → 아무것도 안 함
ipcMain.on("close-cancelled", () => {});

ipcMain.handle("window-is-maximized", () => mainWindow?.isMaximized() ?? false);

app.whenReady().then(() => {
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
  if (pyProcess) pyProcess.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) createMainWindow();
});
