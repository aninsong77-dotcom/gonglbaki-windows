"""
곤글박이 - 로컬 서버 v2
- faster-whisper (실시간 스트리밍)
- GPU 자동 감지
- 침묵 구간 자동 감지
"""
import os, re, tempfile, threading, webbrowser, time, traceback, shutil, json, uuid, zipfile
import numpy as np
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
from flask_cors import CORS

import sys
import platform
import datetime

# PyInstaller 패키징 여부에 따라 경로 분기
if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys.executable).resolve().parent.parent  # resources/
    UI_DIR = BASE_DIR / "dist"
else:
    BASE_DIR = Path(__file__).resolve().parent.parent
    UI_DIR = BASE_DIR / "dist"

# ── 디버그 로그 함수 (개발/패키징 모두 기록) ──────────────────────
DEBUG_LOG_PATH = Path.home() / "gongulbaki_debug.txt"

def cleanup_old_logs():
    """7일 이상 된 로그 줄 삭제"""
    try:
        if not DEBUG_LOG_PATH.exists():
            return
        cutoff = datetime.datetime.now() - datetime.timedelta(days=7)
        with open(DEBUG_LOG_PATH, "r", encoding="utf-8-sig", errors="replace") as f:
            lines = f.readlines()
        kept = []
        for line in lines:
            # 타임스탬프 파싱 시도 — 실패하면 유지
            if line.startswith("[") and len(line) > 20:
                try:
                    ts = datetime.datetime.strptime(line[1:20], "%Y-%m-%d %H:%M:%S")
                    if ts >= cutoff:
                        kept.append(line)
                except ValueError:
                    kept.append(line)
            else:
                kept.append(line)
        with open(DEBUG_LOG_PATH, "w", encoding="utf-8-sig") as f:
            f.writelines(kept)
    except Exception:
        pass

def debug_log(msg: str):
    """타임스탬프와 함께 디버그 파일에 기록"""
    try:
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8-sig") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass

def log_system_info():
    """앱 시작 시 시스템 정보 기록"""
    try:
        import psutil
        ram_total = psutil.virtual_memory().total // (1024 ** 3)
        ram_avail = psutil.virtual_memory().available // (1024 ** 3)
        ram_info = f"{ram_avail}GB 여유 / 전체 {ram_total}GB"
    except Exception:
        ram_info = "확인 불가 (psutil 없음)"

    cpu_count = os.cpu_count() or 4
    thread_count = max(1, cpu_count - 2)

    cleanup_old_logs()
    debug_log("=" * 50)
    debug_log("곤글박이 시작")
    debug_log(f"OS: {platform.system()} {platform.release()} ({platform.architecture()[0]})")
    debug_log(f"Python: {sys.version.split()[0]}")
    debug_log(f"실행 경로: {sys.executable}")
    debug_log(f"패키징 여부: {'예 (frozen)' if getattr(sys, 'frozen', False) else '아니오 (개발 모드)'}")
    debug_log(f"BASE_DIR: {BASE_DIR}")
    debug_log(f"UI_DIR: {UI_DIR} (존재: {UI_DIR.exists()})")
    debug_log(f"RAM: {ram_info}")
    debug_log(f"CPU 코어/스레드 수: {cpu_count}개 → whisper.cpp 사용 스레드: {thread_count}개")
    debug_log("=" * 50)

# 앱 시작 시 시스템 정보 기록
log_system_info()

# ── 좀비 프로세스 방지 (보강) ────────────────────────────────────
# 취소 버튼·정상 종료 시 자식(whisper-cli/llama-completion/ffmpeg) 정리 코드는 이미 있지만,
# 그건 "이 파이썬 코드가 실행될 기회가 있을 때"만 작동한다. 작업관리자 강제종료·크래시처럼
# 코드 자체가 실행 안 되고 죽는 경우엔 무력함. Windows Job Object(KILL_ON_JOB_CLOSE)는
# 이 프로세스가 "어떻게" 죽든(정상/강제/크래시 무관) 운영체제가 자식까지 자동으로 정리해주는
# 보다 근본적인 안전망이다 — 코드 실행 여부와 무관한 커널 레벨 보장.
_job_object_handle = None  # 핸들을 계속 들고 있어야 함(가비지컬렉션되면 무력화됨)

def _enable_kill_children_on_exit():
    global _job_object_handle
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes

        JobObjectExtendedLimitInformation = 9
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_void_p),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # 64비트 핸들 반환 타입을 명시해야 함 — 안 하면 ctypes가 32비트로 착각해 핸들이 깨짐
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.GetCurrentProcess.argtypes = []
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            debug_log("[경고] Job Object 생성 실패 — 좀비 프로세스 방지 보강 미적용(기존 방식은 그대로 작동)")
            return

        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(
            job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info))
        if not ok:
            debug_log("[경고] Job Object 설정 실패 — 좀비 프로세스 방지 보강 미적용(기존 방식은 그대로 작동)")
            return

        if not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
            err = ctypes.get_last_error()
            debug_log(f"[경고] Job Object 연결 실패(에러코드 {err}) — 좀비 프로세스 방지 보강 미적용(기존 방식은 그대로 작동)")
            return

        _job_object_handle = job  # 핸들 유지(닫히면 즉시 무력화되므로 전역에 보관)
        debug_log("좀비 프로세스 방지 보강 완료 (Job Object) — 이 서버가 어떤 식으로 종료되든 자식 프로세스도 자동 정리됨")
    except Exception as e:
        debug_log(f"[경고] Job Object 설정 중 예외: {e} — 좀비 프로세스 방지 보강 미적용(기존 방식은 그대로 작동)")

_enable_kill_children_on_exit()

app = Flask(__name__, static_folder=str(UI_DIR), static_url_path="")
CORS(app, resources={r"/api/*": {"origins": "*"}})

_models = {}

# 진행 중인 변환 요청 추적 (req_id -> {"proc": Popen|None, "cancelled": bool}) — 중지 버튼용.
ACTIVE_JOBS = {}
ACTIVE_JOBS_LOCK = threading.Lock()

def detect_device():
    try:
        import torch
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            debug_log(f"GPU 감지: {gpu_name} → GPU(CUDA) 모드")
            print("[곤글박이] GPU(CUDA) 감지 - GPU 모드")
            return "cuda", "float16"
    except ImportError:
        pass
    debug_log("GPU 없음 → CPU 모드 (int8)")
    print("[곤글박이] CPU 모드")
    return "cpu", "int8"

DEVICE, COMPUTE_TYPE = detect_device()

def get_model(name: str):
    from faster_whisper import WhisperModel
    if name not in _models:
        print(f"[곤글박이] 모델 로드: {name} ({DEVICE})")
        try:
            _models[name] = WhisperModel(name, device=DEVICE, compute_type=COMPUTE_TYPE)
        except Exception as e:
            if DEVICE == "cuda":
                print(f"[곤글박이] GPU 실패, CPU 재시도: {e}")
                _models[name] = WhisperModel(name, device="cpu", compute_type="int8")
            else:
                raise
    return _models[name]

@app.get("/api/debug-log")
def get_debug_log():
    """디버그 파일 내용 반환"""
    try:
        with open(DEBUG_LOG_PATH, "r", encoding="utf-8-sig", errors="replace") as f:
            content = f.read()
        return jsonify(ok=True, content=content)
    except FileNotFoundError:
        return jsonify(ok=False, content="디버그 파일이 없습니다. 앱을 한 번 실행한 뒤 다시 시도해보세요.")
    except Exception as e:
        return jsonify(ok=False, content=str(e))

@app.get("/api/health")
def health():
    return jsonify(ok=True, version="2.0", device=DEVICE)

def get_model_cache_path(name: str) -> Path:
    """huggingface 캐시에서 모델 폴더 경로 반환"""
    cache_dir = Path.home() / ".cache" / "huggingface" / "hub"
    # faster-whisper 모델명 → huggingface repo 폴더명 변환
    repo_map = {
        "small":    "models--Systran--faster-whisper-small",
        "medium":   "models--Systran--faster-whisper-medium",
        "large-v3": "models--Systran--faster-whisper-large-v3",
    }
    folder = repo_map.get(name)
    if not folder:
        return None
    return cache_dir / folder

def is_model_cached(name: str) -> bool:
    """모델이 디스크에 캐시되어 있는지 확인"""
    p = get_model_cache_path(name)
    if p is None:
        return False
    # snapshots 폴더 안에 실제 파일이 있어야 진짜 다운된 것
    snapshots = p / "snapshots"
    if not snapshots.exists():
        return False
    # snapshots 하위 폴더가 하나라도 있으면 OK
    children = list(snapshots.iterdir())
    return len(children) > 0

@app.get("/api/models/status")
def models_status():
    """각 모델의 설치 여부와 현재 로드 상태 반환"""
    result = {}
    for name in ("small", "medium", "large-v3"):
        result[name] = {
            "cached": is_model_cached(name),
            "loaded": name in _models,
        }
    return jsonify(result)

@app.get("/api/models/download/<name>")
def download_single_model(name: str):
    """단일 모델을 SSE 스트리밍으로 다운로드 (실제 진행률 전송)"""
    import json
    import queue
    import os
    if name not in ("small", "medium", "large-v3"):
        return jsonify(error="잘못된 모델명"), 400

    # 모델별 예상 크기 (bytes) — 진행률 계산용
    EXPECTED_BYTES = {
        "small":    488 * 1024 * 1024,
        "medium":  1528 * 1024 * 1024,
        "large-v3": 6173 * 1024 * 1024,
    }

    def get_cache_size():
        """HuggingFace 캐시에서 현재 다운로드된 크기 반환"""
        cache_dir = Path.home() / ".cache" / "huggingface" / "hub"
        model_dir = cache_dir / f"models--Systran--faster-whisper-{name}"
        if not model_dir.exists():
            return 0
        total = 0
        for root, dirs, files in os.walk(model_dir):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except Exception:
                    pass
        return total

    q = queue.Queue()

    def do_download():
        try:
            from faster_whisper import WhisperModel
            _models[name] = WhisperModel(name, device=DEVICE, compute_type=COMPUTE_TYPE)
            q.put({"type": "done", "model": name})
        except Exception as e:
            if DEVICE == "cuda":
                try:
                    _models[name] = WhisperModel(name, device="cpu", compute_type="int8")
                    q.put({"type": "done", "model": name})
                except Exception as e2:
                    q.put({"type": "error", "msg": str(e2)})
            else:
                q.put({"type": "error", "msg": str(e)})

    def generate():
        yield "data: " + json.dumps({"type": "start", "model": name}) + "\n\n"
        t = threading.Thread(target=do_download, daemon=True)
        t.start()
        expected = EXPECTED_BYTES.get(name, 1528 * 1024 * 1024)
        while True:
            try:
                result = q.get(timeout=3)
                yield "data: " + json.dumps(result) + "\n\n"
                break
            except queue.Empty:
                # 실제 진행률 계산 후 전송
                current = get_cache_size()
                progress = min(95, int(current / expected * 100)) if expected > 0 else 0
                yield "data: " + json.dumps({"type": "progress", "progress": progress}) + "\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

@app.delete("/api/models/delete/<name>")
def delete_model(name: str):
    """모델 캐시 폴더 삭제"""
    if name not in ("small", "medium", "large-v3"):
        return jsonify(error="잘못된 모델명"), 400
    # 현재 메모리에 로드된 모델은 삭제 불가
    if name in _models:
        return jsonify(error="현재 사용 중인 모델은 삭제할 수 없습니다."), 400
    p = get_model_cache_path(name)
    if p is None or not p.exists():
        return jsonify(error="모델 캐시를 찾을 수 없습니다."), 404
    try:
        shutil.rmtree(p)
        return jsonify(ok=True, model=name)
    except Exception as e:
        return jsonify(error=str(e)), 500

# ════════════════════════════════════════════════════════════════
# whisper.cpp 모델 관련
# ════════════════════════════════════════════════════════════════

CPP_MODELS_DIR = Path(r"C:\whisper-models")

CPP_MODEL_FILES = {
    "small":    "ggml-small.bin",
    "medium":   "ggml-medium.bin",
    "large-v3": "ggml-large-v3.bin",
    # 기본 모델 (2026-07 단일화): OpenAI large-v3-turbo — large급 정확도 + medium급 속도
    "large-v3-turbo": "ggml-large-v3-turbo.bin",
}

CPP_MODEL_URLS = {
    "small":    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    "medium":   "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    "large-v3": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
    "large-v3-turbo": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
}

# 다운로드 진행률(%) 계산용 예상 전체 크기(bytes) — 실측 파일 크기 기준
CPP_MODEL_SIZE_BYTES = {
    "small": 488_000_000,
    "medium": 1_530_000_000,
    "large-v3": 3_090_000_000,
    "large-v3-turbo": 1_624_555_275,
}

def get_cpp_model_path(name: str) -> Path:
    filename = CPP_MODEL_FILES.get(name)
    if not filename:
        return None
    return CPP_MODELS_DIR / filename

def is_cpp_model_cached(name: str) -> bool:
    p = get_cpp_model_path(name)
    if p is None:
        return False
    return p.exists() and p.stat().st_size > 1_000_000  # 1MB 이상이면 정상

@app.get("/api/models/cpp/status")
def cpp_models_status():
    """whisper.cpp 모델 설치 여부 반환"""
    result = {}
    for name in CPP_MODEL_FILES:
        result[name] = {
            "cached": is_cpp_model_cached(name),
            "loaded": False,  # cpp는 매번 실행 방식이라 로드 상태 없음
        }
    return jsonify(result)

@app.get("/api/models/cpp/download/<name>")
def download_cpp_model(name: str):
    """whisper.cpp 모델을 SSE 스트리밍으로 다운로드"""
    import json, queue, urllib.request
    if name not in CPP_MODEL_URLS:
        return jsonify(error="잘못된 모델명"), 400

    q = queue.Queue()
    CPP_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    dest = get_cpp_model_path(name)
    url  = CPP_MODEL_URLS[name]

    def do_download():
        try:
            urllib.request.urlretrieve(url, dest)
            q.put({"type": "done", "model": name})
        except Exception as e:
            q.put({"type": "error", "msg": str(e)})

    total_bytes = CPP_MODEL_SIZE_BYTES.get(name)

    def generate():
        yield "data: " + json.dumps({"type": "start", "model": name}) + "\n\n"
        t = threading.Thread(target=do_download, daemon=True)
        t.start()
        while True:
            try:
                result = q.get(timeout=1)
                yield "data: " + json.dumps(result) + "\n\n"
                break
            except queue.Empty:
                # 실제 다운로드된 바이트 수 기준 진행률(%) — 임시 파일(.tmp)로 받는 urlretrieve 특성상
                # dest 파일이 아직 없을 수 있어 존재 확인 후 계산
                done = dest.stat().st_size if dest.exists() else 0
                pct = min(99, int(done / total_bytes * 100)) if total_bytes else None
                yield "data: " + json.dumps({"type": "progress", "progress": pct, "done_mb": done // (1024*1024)}) + "\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

@app.delete("/api/models/cpp/delete/<name>")
def delete_cpp_model(name: str):
    """whisper.cpp 모델 파일 삭제"""
    if name not in CPP_MODEL_FILES:
        return jsonify(error="잘못된 모델명"), 400
    p = get_cpp_model_path(name)
    if p is None or not p.exists():
        return jsonify(error="모델 파일을 찾을 수 없습니다."), 404
    try:
        p.unlink()
        return jsonify(ok=True, model=name)
    except Exception as e:
        return jsonify(error=str(e)), 500

# ════════════════════════════════════════════════════════════════

@app.get("/api/download-models")
def download_models():
    """세 모델을 순서대로 다운로드하고 진행상황을 SSE로 스트리밍"""
    import json
    from faster_whisper import WhisperModel

    models = [
        ("small",    "Small  (약 250MB)"),
        ("medium",   "Medium (약 750MB)"),
        ("large-v3", "Large  (약 6GB)  "),
    ]

    def generate():
        total = len(models)
        for i, (name, label) in enumerate(models):
            if name in _models:
                # 이미 로드된 모델은 스킵
                yield "data: " + json.dumps({
                    "type": "skip",
                    "model": name,
                    "label": label,
                    "index": i + 1,
                    "total": total,
                }) + "\n\n"
                continue

            yield "data: " + json.dumps({
                "type": "start",
                "model": name,
                "label": label,
                "index": i + 1,
                "total": total,
            }) + "\n\n"

            try:
                _models[name] = WhisperModel(name, device=DEVICE, compute_type=COMPUTE_TYPE)
                yield "data: " + json.dumps({
                    "type": "done",
                    "model": name,
                    "label": label,
                    "index": i + 1,
                    "total": total,
                }) + "\n\n"
            except Exception as e:
                if DEVICE == "cuda":
                    try:
                        _models[name] = WhisperModel(name, device="cpu", compute_type="int8")
                        yield "data: " + json.dumps({
                            "type": "done",
                            "model": name,
                            "label": label,
                            "index": i + 1,
                            "total": total,
                        }) + "\n\n"
                    except Exception as e2:
                        yield "data: " + json.dumps({
                            "type": "error",
                            "model": name,
                            "msg": str(e2),
                        }) + "\n\n"
                else:
                    yield "data: " + json.dumps({
                        "type": "error",
                        "model": name,
                        "msg": str(e),
                    }) + "\n\n"

        yield "data: " + json.dumps({"type": "complete"}) + "\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

def get_whisper_cpp_exe() -> Path:
    r"""whisper-cli.exe 경로 반환 — 항상 영문 경로 C:\whisper-bin 우선"""
    # 영문 고정 경로 (한글 경로 문제 회피)
    fixed = Path(r"C:\whisper-bin\whisper-cli.exe")
    if fixed.exists():
        return fixed
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent / "whisper-bin" / "whisper-cli.exe"
    else:
        return Path(__file__).resolve().parent / "whisper-bin" / "whisper-cli.exe"

def get_ffmpeg_exe() -> str:
    r"""ffmpeg 실행파일 경로 — 앱에 번들된 whisper-bin/ffmpeg 우선, 없으면 PATH 의 ffmpeg 폴백(개발 환경용)"""
    exe_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    if getattr(sys, 'frozen', False):
        bundled = Path(sys.executable).resolve().parent / "whisper-bin" / exe_name
    else:
        bundled = Path(__file__).resolve().parent / "whisper-bin" / exe_name
    if bundled.exists():
        return str(bundled)
    return "ffmpeg"

def convert_to_wav_eng(src_path: str) -> str:
    """
    ffmpeg으로 16kHz Mono WAV 변환.
    임시파일을 C:\\whisper-models\\temp_XXXX.wav 처럼 영문 경로에 저장.
    """
    import subprocess, uuid
    tmp_dir = Path(r"C:\whisper-models")
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        debug_log(f"[오류] C:\\whisper-models 폴더 생성 실패: {e}")
        raise Exception("임시 폴더를 만들 수 없어요. C드라이브 쓰기 권한이 없거나 보안 프로그램이 차단하고 있을 수 있어요. 설정에서 faster-whisper 엔진으로 바꿔보세요.")
    wav_path = str(tmp_dir / f"temp_{uuid.uuid4().hex[:8]}.wav")
    startupinfo = None
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
    try:
        subprocess.run(
            [get_ffmpeg_exe(), "-y", "-i", src_path,
             "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
            capture_output=True, check=True, startupinfo=startupinfo
        )
        debug_log(f"ffmpeg 변환 성공: {wav_path}")
    except FileNotFoundError:
        debug_log("[오류] ffmpeg 실행파일을 찾을 수 없음 (PATH 확인 필요)")
        raise Exception("파일 변환 도구를 찾을 수 없어요. 앱을 재설치 후 다시 시도해보세요.")
    except subprocess.CalledProcessError as e:
        debug_log(f"[오류] ffmpeg 변환 실패: {e.stderr.decode('utf-8', errors='replace') if e.stderr else str(e)}")
        raise Exception("음성 파일을 변환하지 못했어요. 파일이 손상됐거나 지원하지 않는 형식일 수 있어요. 앱을 재실행 후 다시 시도해보세요.")
    return wav_path

# ════════════════════════════════════════════════════════════════
# 분석 기능 (빈출 단어 + 회기 요약) — 전부 온디바이스, 내용은 화면으로만 전달
# 빈출 단어 = Kiwi 형태소 분석(실제 집계) / 요약 = Kanana-1.5-2.1B(카카오, llama.cpp, AI 초안)
# 2026-07-09 Qwen3-4B → Kanana 교체: 같은 더미대본 9회 A/B 검증에서 한국어 자연스러움·
# 속도(2~3배)·용량(2.5→1.5GB) 우세. Apache 2.0. 검증 기록 = 요약모델_테스트/비교결과*.md
# ════════════════════════════════════════════════════════════════

# 모델 출처: 카카오 공식 원본(kakaocorp/kanana-1.5-2.1b-instruct-2505)을 우리가 직접
# GGUF 변환·Q4_K_M 양자화해 곤글박이 GitHub 릴리스에 올린 것 — 제3자 변환본 미사용
# (보안 원칙: 배포 모델은 출처가 깨끗한 파일만. 변환 절차 = 요약모델_테스트/)
LLM_MODEL_FILE = "kanana-1.5-2.1b-instruct-Q4_K_M.gguf"
LLM_MODEL_URL = "https://github.com/aninsong77-dotcom/gonglbaki-windows/releases/download/models/" + LLM_MODEL_FILE

def get_llm_model_path() -> Path:
    return Path(r"C:\whisper-models") / LLM_MODEL_FILE

def get_llama_exe() -> Path:
    r"""llama-completion.exe 경로 — 영문 고정 경로 C:\llama-bin 우선 (whisper-cli와 동일 규칙).
    주의: llama-cli.exe가 아니라 llama-completion.exe여야 함 (cli는 비대화 모드 미지원 → 입력 대기로 멈춤)."""
    fixed = Path(r"C:\llama-bin\llama-completion.exe")
    if fixed.exists():
        return fixed
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent / "llama-bin" / "llama-completion.exe"
    else:
        return Path(__file__).resolve().parent / "llama-bin" / "llama-completion.exe"

ANALYZE_CHUNK_CHARS = 3000
_ANALYZE_TIMESTAMP = re.compile(r"\(\d{2}:\d{2}\)\s*")
_ANALYZE_SILENCE = re.compile(r"^\(침묵.*\)$")
_ANALYZE_SPEAKER = re.compile(r"^\s*\[?([A-Za-z가-힣]{1,4}\d{0,2})\]?\s*[:)]\s+")

_ANALYZE_STOPWORDS = {
    "것", "거", "게", "뭐", "때", "수", "좀", "네", "예", "응", "어", "음",
    "그것", "이것", "저것", "여기", "거기", "저기", "이거", "그거", "저거",
    "때문", "정도", "경우", "부분", "가지", "번", "분", "일", "말", "얘기",
    "지금", "이제", "오늘", "그때", "다음", "처음", "하나", "둘", "사람",
}

# 지시문 참고: 2차 검증(요약모델_테스트/비교결과_2차_kanana.md)에서 확인된 Kanana 버릇 교정 —
# ① 문장 수 제한을 무시하고 길게 씀 → "반드시 지켜라" 강조 ② 상담자가 낸 과제를 [내담자]
# 칸에 섞음 → 소속 규칙 명시 ③ 축어록에 없는 행동(예: 병원 권유)을 상담자가 했다고
# 서술하는 미세 왜곡 → 금지 문구 추가. (/no_think 는 Qwen 전용 토큰이라 제거)
# 축어록 표기 관례: 발언 중 괄호( )는 ①그 순간 상대방이 짧게 끼어든 말(맞장구·짧은 질문)
# 이거나 ②(웃음)(침묵)(한숨) 같은 비언어 행동이다 — 현재 화자의 말이 아님. 요약 AI가
# 이를 화자의 발언으로 오인하지 않도록 지시문에 명시(2026-07-09 사용자 요청).
_TRANSCRIPT_PAREN_RULE = (
    "축어록 표기 규칙: 발언 중간의 괄호( ) 안 내용은 그 화자의 말이 아니다 — "
    "상대방이 짧게 끼어든 말이거나, (웃음)(침묵)(한숨) 같은 비언어적 행동이다. "
    "괄호 안 말은 상대 화자의 반응으로, 비언어 표현은 감정 단서로만 참고하라. "
)
_ANALYZE_SYS_MAP_PLAIN = (
    "당신은 상담 축어록을 정리하는 조수다. 주어진 축어록 조각의 핵심 내용을 "
    "한국어로 요약하라. 내담자가 말한 주제, 드러난 감정, 상담자의 개입을 담아라. "
    + _TRANSCRIPT_PAREN_RULE +
    "반드시 3~5문장 이내로 써라. 축어록에 없는 내용이나 하지 않은 행동을 지어내지 마라."
)
_ANALYZE_SYS_MAP_LABELED = (
    "당신은 상담 축어록을 정리하는 조수다. 축어록 조각에서 화자 표시(상=상담사, 내=내담자)를 참고해 "
    "반드시 아래 두 부분으로 나눠 요약하라. 문장 수 제한을 반드시 지켜라.\n"
    "[내담자] 내담자가 말한 주제와 드러난 감정 — 반드시 2~3문장\n"
    "[상담자] 상담자의 개입·반응·부여한 과제 — 반드시 1~2문장\n"
    "상담자가 제안한 과제나 개입은 [상담자]에만 써라. "
    + _TRANSCRIPT_PAREN_RULE +
    "축어록에 없는 내용이나 하지 않은 행동을 지어내지 마라."
)
_ANALYZE_SYS_REDUCE = {
    "all": ("당신은 상담 축어록을 정리하는 조수다. 아래 부분 요약들을 종합해 한국어로 전체 회기 요약을 작성하라. "
            "형식: ①주요 호소/주제 ②감정의 흐름 ③상담자의 주요 개입 ④다음 회기 관련 사항(있을 때만). "
            "이 네 항목 외에 다른 문단을 덧붙이지 마라. 반드시 10문장 이내. "
            "부분 요약에 없는 내용을 지어내지 마라."),
    "nae": ("당신은 상담 축어록을 정리하는 조수다. 아래 부분 요약들 중 [내담자] 항목을 중심으로, "
            "내담자의 호소·주제·감정의 흐름을 한국어로 종합 요약하라. 반드시 8문장 이내. "
            "부분 요약에 없는 내용을 지어내지 마라."),
    "sang": ("당신은 상담 축어록을 정리하는 조수다. 아래 부분 요약들 중 [상담자] 항목을 중심으로, "
             "상담자가 사용한 개입·반응·기법의 흐름을 한국어로 종합 요약하라. 반드시 8문장 이내. "
             "부분 요약에 없는 내용을 지어내지 마라."),
}

_analyze_state = {"proc": None, "cancelled": False, "busy": False}
_analyze_lock = threading.Lock()
_kiwi_instance = None

def _get_kiwi():
    global _kiwi_instance
    if _kiwi_instance is None:
        from kiwipiepy import Kiwi
        debug_log("형태소 분석기(Kiwi) 로드")
        _kiwi_instance = Kiwi()
    return _kiwi_instance

def _analyze_clean_lines(text):
    out = []
    for raw in text.splitlines():
        line = _ANALYZE_TIMESTAMP.sub("", raw.strip())
        if line and not _ANALYZE_SILENCE.match(line):
            out.append(line)
    return out

# ── 요약 서버(모델 상주) 관리 ─────────────────────────────────────────
# 예전에는 조각마다 llama-completion.exe를 새로 띄워 모델(1.5GB)을 매번 다시
# 로드했다 — 조각이 15개면 로드만 15번. llama-server를 첫 요청 때 한 번 띄워
# 상주시키고 HTTP로 재사용해 이 낭비를 없앤다(2026-07-09). GPU는 안 씀(CPU 동일).
# 포트는 고정하지 않고 빈 포트를 그때그때 고른다 — 고정 포트(5599)를 쓰면
# 앱이 두 개 떠 있거나 예전 서버가 남아 있을 때 낡은 서버(다른 설정)로 요청이
# 가버리는 사고가 남(2026-07-09 실사고: 컨텍스트 4096짜리 잔재 서버가 응답).
_llama_server = {"proc": None, "port": None}

def _pick_free_port() -> int:
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port

def _llama_server_alive():
    p = _llama_server["proc"]
    return p is not None and p.poll() is None

def _stop_llama_server():
    p = _llama_server["proc"]
    if p is not None:
        try: p.kill()
        except Exception: pass
    _llama_server["proc"] = None

def _ensure_llama_server() -> bool:
    """상주 요약 서버 보장 — 떠 있으면 그대로, 없으면 기동 후 모델 로드(/health) 대기."""
    import subprocess, urllib.request
    if _llama_server_alive():
        return True
    exe = get_llama_exe().parent / "llama-server.exe"
    if not exe.exists() or not get_llm_model_path().exists():
        return False
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    port = _pick_free_port()
    debug_log(f"요약 서버(모델 상주) 기동 중... (포트 {port})")
    # 컨텍스트 16384: 조각 22개짜리 긴 축어록의 종합(reduce) 입력이 4096을 넘겨
    # exceed_context_size_error(400)로 빈 결과가 나온 실사고(2026-07-09)에서 확장.
    # Kanana는 32k까지 지원, 2.1B라 메모리 부담도 크지 않음.
    proc = subprocess.Popen(
        [str(exe), "-m", str(get_llm_model_path()),
         "--host", "127.0.0.1", "--port", str(port), "-c", "16384"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL, creationflags=flags)
    _llama_server["proc"] = proc
    _llama_server["port"] = port
    deadline = time.time() + 120  # 모델 로드 최대 2분 대기
    while time.time() < deadline:
        if proc.poll() is not None:  # 기동 실패로 죽음
            _llama_server["proc"] = None
            return False
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                if r.status == 200:
                    debug_log("요약 서버 준비 완료")
                    return True
        except Exception:
            time.sleep(0.5)
    _stop_llama_server()
    return False

def _analyze_ask_llm(system, user, max_tokens=500):
    """상주 요약 서버에 1회 요청. 취소되면 None."""
    import json as _json, urllib.request, urllib.error
    with _analyze_lock:
        if _analyze_state["cancelled"]:
            return None
    if not _ensure_llama_server():
        debug_log("[오류] 요약 서버 기동 실패 — 모델 파일 또는 실행파일 없음")
        return ""
    # Kanana 1.5 = Llama3 계열 채팅 양식 (Qwen의 ChatML과 다름 — 잘못 넣으면 품질 왜곡)
    prompt = (f"<|start_header_id|>system<|end_header_id|>\n\n{system}<|eot_id|>"
              f"<|start_header_id|>user<|end_header_id|>\n\n{user}<|eot_id|>"
              f"<|start_header_id|>assistant<|end_header_id|>\n\n")
    body = _json.dumps({"prompt": prompt, "n_predict": max_tokens,
                        "temperature": 0.3, "stream": False}).encode("utf-8")
    req = urllib.request.Request(f"http://127.0.0.1:{_llama_server['port']}/completion",
                                 data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=900) as r:  # 조각 하나 15분 초과 = 비정상
            out = _json.loads(r.read().decode("utf-8")).get("content", "")
    except urllib.error.HTTPError as e:
        # 에러 본문에는 축어록 내용이 없고 서버 상태 메시지만 있음 — 로그 안전
        try: msg = e.read().decode("utf-8", errors="replace")[:300]
        except Exception: msg = ""
        debug_log(f"[오류] 요약 서버 HTTP {e.code}: {msg}")
        out = ""
    except Exception as e:
        # 취소로 서버가 죽었거나 연결 실패 — 아래에서 cancelled 확인
        if not _analyze_state["cancelled"]:
            debug_log(f"[오류] 요약 서버 요청 실패: {type(e).__name__}")
        out = ""
    with _analyze_lock:
        if _analyze_state["cancelled"]:
            return None
    out = re.sub(r"\x1b\[[0-9;]*m", "", out or "")
    out = re.sub(r"<think>.*?</think>", "", out, flags=re.S)
    out = out.replace("<think>", "").replace("</think>", "")
    out = re.sub(r"\n?>\s*EOF by user\s*$", "", out)
    return out.replace("<|im_end|>", "").replace("<|eot_id|>", "").strip()

def _reduce_partials(sys_msg, partials, max_tokens=800):
    """부분 요약들을 종합. 아주 긴 회기(부분 요약 수십 개)는 한 번에 넣으면 컨텍스트를
    초과하므로, 묶음별로 먼저 종합한 뒤 그 결과를 다시 종합한다(2단계).
    글자 수 한도 16000자 ≈ 9천 토큰(Kanana 토크나이저 실측 약 0.56토큰/자) — 16384 컨텍스트에 안전."""
    LIMIT = 16000
    text = "부분 요약들:\n\n" + "\n\n".join(partials)
    if len(text) <= LIMIT:
        return _analyze_ask_llm(sys_msg, text, max_tokens)
    groups, cur, cur_len = [], [], 0
    for p in partials:
        if cur and cur_len + len(p) > LIMIT:
            groups.append(cur); cur, cur_len = [], 0
        cur.append(p); cur_len += len(p)
    if cur:
        groups.append(cur)
    debug_log(f"종합 입력이 길어 2단계로 진행 (묶음 {len(groups)}개)")
    interim = []
    for g in groups:
        s = _analyze_ask_llm(sys_msg, "부분 요약들:\n\n" + "\n\n".join(g), max_tokens)
        if s is None:
            return None
        if s:
            interim.append(s)
    return _analyze_ask_llm(sys_msg, "부분 요약들:\n\n" + "\n\n".join(interim), max_tokens)

@app.get("/api/analyze/status")
def analyze_status():
    """분석 기능 준비 상태 — 요약 모델 존재 여부 + 실행파일 여부"""
    try:
        import kiwipiepy  # noqa: F401
        kiwi_ok = True
    except ImportError:
        kiwi_ok = False
    return jsonify(
        llm_model=get_llm_model_path().exists(),
        llama_exe=get_llama_exe().exists(),
        kiwi=kiwi_ok,
        model_size_mb=1452,
    )

@app.get("/api/analyze/model/download")
def analyze_model_download():
    """요약 모델(Kanana-1.5-2.1B, 약 1.5GB) SSE 다운로드 — cpp 모델 다운로드와 동일 패턴"""
    import json, queue, urllib.request
    q = queue.Queue()
    Path(r"C:\whisper-models").mkdir(parents=True, exist_ok=True)
    dest = get_llm_model_path()

    def do_download():
        try:
            urllib.request.urlretrieve(LLM_MODEL_URL, dest)
            q.put({"type": "done"})
        except Exception as e:
            q.put({"type": "error", "msg": str(e)})

    def generate():
        yield "data: " + json.dumps({"type": "start"}) + "\n\n"
        t = threading.Thread(target=do_download, daemon=True)
        t.start()
        while True:
            try:
                result = q.get(timeout=5)
                yield "data: " + json.dumps(result) + "\n\n"
                break
            except queue.Empty:
                done_mb = dest.stat().st_size // (1024*1024) if dest.exists() else 0
                yield "data: " + json.dumps({"type": "progress", "done_mb": done_mb, "total_mb": 1452}) + "\n\n"

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.delete("/api/analyze/model/delete")
def analyze_model_delete():
    p = get_llm_model_path()
    if not p.exists():
        return jsonify(error="모델 파일이 없습니다."), 404
    _stop_llama_server()  # 상주 서버가 모델 파일을 잡고 있으면 삭제가 실패하므로 먼저 내림
    try:
        p.unlink()
        return jsonify(ok=True)
    except Exception as e:
        return jsonify(error=str(e)), 500

@app.post("/api/analyze/words")
def analyze_words():
    """빈출 단어 집계 (Kiwi) — 전체 + 화자별 + 내담자 합산. 내용은 응답으로만, 로그 금지."""
    from collections import Counter
    text = (request.get_json(silent=True) or {}).get("text", "")
    debug_log(f"단어 정리 요청 ({len(text)}자)")
    kiwi = _get_kiwi()
    by_speaker, plain = {}, []
    for line in _analyze_clean_lines(text):
        m = _ANALYZE_SPEAKER.match(line)
        if m:
            by_speaker.setdefault(m.group(1), []).append(line[m.end():])
        else:
            plain.append(line)

    # 괄호( ) 안은 상대방의 짧은 반응이거나 (웃음) 같은 비언어 행동 — 현재 화자의
    # 말이 아니므로 화자별 단어 집계에서 제외한다(2026-07-09 표기 관례 반영).
    paren = re.compile(r"\([^)]{0,60}\)")
    def count(sentences):
        c = Counter()
        for s in sentences:
            for tok in kiwi.tokenize(paren.sub(" ", s)):
                if tok.tag in ("NNG", "NNP") and len(tok.form) >= 2 and tok.form not in _ANALYZE_STOPWORDS:
                    c[tok.form] += 1
        return c

    # 개별 화자(상1/내1/내2...)가 아니라 역할(상담자/내담자/제3자/기타) 단위로 합쳐서 집계.
    # "상1"·"상2"처럼 같은 역할이 여러 번 등장해도 하나로 묶임.
    ROLE_ORDER = ["제3자", "상", "내", "기타"]  # "제3자"를 먼저 검사(다른 접두어와 안 겹침)
    def role_of(label):
        for prefix in ROLE_ORDER:
            if label.startswith(prefix):
                return {"제3자": "제3자", "상": "상담자", "내": "내담자", "기타": "기타"}[prefix]
        return label
    by_role = {}
    for label, sents in by_speaker.items():
        by_role.setdefault(role_of(label), []).extend(sents)

    all_s = [s for v in by_speaker.values() for s in v] + plain
    result = {"overall": count(all_s).most_common(50), "speakers": {}}
    if len(by_role) >= 2:
        for role, sents in sorted(by_role.items(), key=lambda kv: -len(kv[1])):
            result["speakers"][role] = count(sents).most_common(30)
    return jsonify(result)

@app.post("/api/analyze/summarize")
def analyze_summarize():
    """회기 요약 (SSE) — 조각별 요약(map, 라벨 있으면 [내담자]/[상담자] 구조화) 후 종합(reduce).
    partials를 응답에 포함 → 화면이 보관했다가 /api/analyze/reduce 로 화자별 요약을 싸게 재생성."""
    import json
    body = request.get_json(silent=True) or {}
    text = body.get("text", "")
    if not get_llm_model_path().exists():
        return jsonify(error="요약 모델이 아직 다운로드되지 않았어요. 설정에서 받아주세요."), 400
    with _analyze_lock:
        if _analyze_state["busy"]:
            return jsonify(error="이미 분석이 진행 중이에요. 끝날 때까지 기다리거나 중지해주세요."), 409
        _analyze_state["busy"] = True
        _analyze_state["cancelled"] = False

    lines = _analyze_clean_lines(text)
    labeled = sum(1 for l in lines if _ANALYZE_SPEAKER.match(l)) >= max(2, len(lines) // 4)
    body_text = "\n".join(lines)
    chunks = [body_text[i:i+ANALYZE_CHUNK_CHARS] for i in range(0, len(body_text), ANALYZE_CHUNK_CHARS)]
    sys_map = _ANALYZE_SYS_MAP_LABELED if labeled else _ANALYZE_SYS_MAP_PLAIN
    # 이어하기: 화면이 보관해둔 "이미 끝난 조각 요약들"을 보내오면 그 다음 조각부터 진행.
    # 조각 나누기는 같은 텍스트면 항상 같은 결과라 번호가 어긋나지 않는다.
    resume = body.get("resume_chunks") or []  # [{"index": 1, "text": "..."}] 순서대로
    resume = resume[:len(chunks)] if isinstance(resume, list) else []
    start_from = len(resume)
    debug_log(f"요약 요청 ({len(text)}자 → 조각 {len(chunks)}개, 화자라벨 {'있음' if labeled else '없음'}"
              + (f", 이어하기 {start_from}개 건너뜀" if start_from else "") + ")")

    def generate():
        try:
            partials = [f"[조각 {i+1}]\n{c.get('text','')}" for i, c in enumerate(resume)]
            for i, ch in enumerate(chunks, 1):
                if i <= start_from:
                    continue
                yield "data: " + json.dumps({"type": "progress", "msg": f"조각 {i}/{len(chunks)} 요약 중...", "current": i, "total": len(chunks)}) + "\n\n"
                s = _analyze_ask_llm(sys_map, "다음 상담 축어록 조각을 요약하라:\n\n" + ch)
                if s is None:
                    yield "data: " + json.dumps({"type": "cancelled"}) + "\n\n"
                    return
                partials.append(f"[조각 {i}]\n{s}")
                # 끝난 조각을 바로 화면에 보여줌 — 최종 종합까지 기다릴 필요 없이 확인 가능
                yield "data: " + json.dumps({"type": "chunk", "index": i, "total": len(chunks), "text": s}) + "\n\n"
            yield "data: " + json.dumps({"type": "progress", "msg": "부분 요약 종합 중..."}) + "\n\n"
            final = _reduce_partials(_ANALYZE_SYS_REDUCE["all"], partials, 800)
            if final is None:
                yield "data: " + json.dumps({"type": "cancelled"}) + "\n\n"
                return
            yield "data: " + json.dumps({"type": "done", "final": final, "partials": partials, "labeled": labeled}) + "\n\n"
            debug_log("요약 완료")
        except (ConnectionAbortedError, BrokenPipeError):
            debug_log("요약 중 연결 끊김 - 중단")
            with _analyze_lock:
                _analyze_state["cancelled"] = True
                p = _analyze_state["proc"]
            if p:
                try: p.kill()
                except Exception: pass
        finally:
            with _analyze_lock:
                _analyze_state["busy"] = False

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.post("/api/analyze/reduce")
def analyze_reduce():
    """이미 만든 조각 요약(partials)으로 범위별(전체/내담자/상담자) 종합만 재실행 — 1분급."""
    body = request.get_json(silent=True) or {}
    partials = body.get("partials") or []
    scope = body.get("scope", "all")
    if scope not in _ANALYZE_SYS_REDUCE:
        scope = "all"
    if not partials:
        return jsonify(error="partials 필요"), 400
    with _analyze_lock:
        if _analyze_state["busy"]:
            return jsonify(error="이미 분석이 진행 중이에요."), 409
        _analyze_state["busy"] = True
        _analyze_state["cancelled"] = False
    try:
        final = _reduce_partials(_ANALYZE_SYS_REDUCE[scope], partials, 800)
        if final is None:
            return jsonify(cancelled=True)
        return jsonify(final=final, scope=scope)
    finally:
        with _analyze_lock:
            _analyze_state["busy"] = False

@app.post("/api/analyze/stop")
def analyze_stop():
    with _analyze_lock:
        _analyze_state["cancelled"] = True
        p = _analyze_state["proc"]
    if p:
        try: p.kill()
        except Exception: pass
    # 진행 중이던 생성을 즉시 끊기 위해 상주 서버를 내림 — 다음 요약 때 자동 재기동
    _stop_llama_server()
    debug_log("분석 중지 요청 처리됨")
    return jsonify(ok=True)

# ════════════════════════════════════════════════════════════════

@app.post("/api/transcribe/stop")
def transcribe_stop():
    """진행 중인 변환 요청을 즉시 중단. req_id로 등록된 프로세스를 강제 종료하고
    cancelled 플래그를 세워 generate()가 다음 조각으로 안 넘어가고 정리 후 끝나게 한다."""
    req_id = (request.get_json(silent=True) or {}).get("req_id") or request.form.get("req_id")
    if not req_id:
        return jsonify(ok=False, error="req_id 필요"), 400
    with ACTIVE_JOBS_LOCK:
        job = ACTIVE_JOBS.get(req_id)
        if job is None:
            return jsonify(ok=False, error="해당 요청을 찾을 수 없어요(이미 끝났을 수 있음)"), 404
        job["cancelled"] = True
        proc = job.get("proc")
    if proc is not None:
        try:
            if proc.poll() is None:
                proc.kill()
        except Exception:
            pass
    debug_log(f"변환 중지 요청 수신: req_id={req_id}")
    return jsonify(ok=True)

@app.post("/api/transcribe")
def transcribe():
    if "file" not in request.files:
        return jsonify(error="file 필요"), 400
    model_name = request.form.get("model", "large-v3-turbo")
    if model_name not in ("small", "medium", "large-v3", "large-v3-turbo"):
        model_name = "large-v3-turbo"
    engine = request.form.get("engine", "python")  # "python" or "cpp"
    show_time = request.form.get("show_time", "false").lower() == "true"
    start_sec = float(request.form.get("start_sec", "0"))
    req_id = request.form.get("req_id") or uuid.uuid4().hex

    f = request.files["file"]
    suffix = Path(f.filename or "audio.wav").suffix.lower() or ".wav"

    # 지원 파일 형식 사전 검사
    SUPPORTED_EXTS = {".mp3", ".wav", ".m4a", ".mp4", ".mov", ".avi", ".flac", ".ogg", ".aac", ".wma", ".webm", ".mkv"}
    if suffix not in SUPPORTED_EXTS:
        debug_log(f"[오류] 지원하지 않는 파일 형식: {suffix} (파일명: {f.filename})")
        return Response(
            "data: " + json.dumps({"type": "error", "msg": f"'{suffix}' 형식은 지원하지 않아요. MP3, WAV, M4A, MP4 등 음성/영상 파일을 올려주세요."}) + "\n\n",
            mimetype="text/event-stream"
        )
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        f.save(tmp.name)
        tmp_path = tmp.name

    def generate():
        import json, re, subprocess, difflib, uuid, wave
        wav_path = None
        proc = None  # 좀비 프로세스 방지용

        def is_cancelled() -> bool:
            with ACTIVE_JOBS_LOCK:
                job = ACTIVE_JOBS.get(req_id)
                return bool(job and job["cancelled"])

        def set_active_proc(p):
            with ACTIVE_JOBS_LOCK:
                job = ACTIVE_JOBS.get(req_id)
                if job is not None:
                    job["proc"] = p

        with ACTIVE_JOBS_LOCK:
            ACTIVE_JOBS[req_id] = {"proc": None, "cancelled": False}
        try:
            from faster_whisper import decode_audio

            debug_log(f"변환 시작 — 엔진: {engine}, 모델: {model_name}, 파일: {suffix}, req_id: {req_id}")

            yield "data: " + json.dumps({"type":"req_id","req_id":req_id}) + "\n\n"
            yield "data: " + json.dumps({"type":"status","msg":"음향 분석 중..."}) + "\n\n"
            try:
                audio_full = decode_audio(tmp_path, sampling_rate=16000)
            except Exception as e:
                debug_log(f"[오류] 오디오 로드 실패: {e}")
                yield "data: " + json.dumps({"type":"error","msg":"음성 파일을 읽지 못했어요. 파일이 손상됐거나 지원하지 않는 형식일 수 있어요. 앱을 재실행 후 다시 시도해보세요."}) + "\n\n"
                return

            samples_per_sec = 16000
            total_duration_sec = len(audio_full) / samples_per_sec
            start_sample = int(start_sec * samples_per_sec)
            audio = audio_full[start_sample:]

            # 침묵 구간 감지
            silence_map, silence_start = [], None
            for i in range(int(len(audio) / samples_per_sec)):
                chunk = audio[i*samples_per_sec:(i+1)*samples_per_sec]
                volume = float(np.max(np.abs(chunk))) if len(chunk) > 0 else 0
                if volume < 0.025:
                    if silence_start is None: silence_start = i
                else:
                    if silence_start is not None:
                        dur = i - silence_start
                        if dur >= 5: silence_map.append({"start":silence_start,"end":i,"dur":dur})
                        silence_start = None

            # 긴 파일 반복(할루시네이션) 방지: 무음(≥SILENCE_CUT_MIN초)은 경계든 조각 '중간'이든 상관없이
            # 실제 오디오에서 가운데를 도려낸다(앞뒤 SILENCE_PAD_SEC초만 남김) — 모델이 무음을 아예 못 보게 해서
            # "네." 같은 무음발 반복 헛소리(할루시네이션)를 원천 차단한다. (경계 근처만 자르던 이전 방식은
            # 조각 중간에 낀 긴 무음—실측 최대 113초—을 못 잡아서 반복이 남아있었음: 무음이 길수록 반복도 늘었음.)
            CHUNK_SEC = 600
            OVERLAP_SEC = 8
            SILENCE_CUT_MIN = 5     # 이 이상 길이의 무음이면 도려내기 대상
            SILENCE_SHOW_MIN = 30   # 이 이상 길이의 무음만 화면에 "(침묵)"으로 표시(짧은 침묵은 표시 안 함)
            SILENCE_PAD_SEC = 0     # 무음 앞뒤로 이만큼만 남기고 나머지는 모델에 안 먹임 (패딩이 할루시네이션 유발 의심되어 실험적으로 0)

            def build_keep_segments(total_dur: float):
                """[(원본 시작초, 원본 끝초), ...] — 무음 가운데를 도려낸 뒤 실제로 모델에 먹일 구간(시간순)."""
                cuts = []
                for sm in silence_map:
                    if sm["dur"] < SILENCE_CUT_MIN:
                        continue
                    cut_start = sm["start"] + SILENCE_PAD_SEC
                    cut_end = sm["end"] - SILENCE_PAD_SEC
                    if cut_end > cut_start:
                        cuts.append((cut_start, cut_end))
                keep, pos = [], 0.0
                for cut_start, cut_end in cuts:
                    if cut_start > pos:
                        keep.append((pos, cut_start))
                    pos = max(pos, cut_end)
                if pos < total_dur:
                    keep.append((pos, total_dur))
                return keep

            remaining_dur = len(audio) / samples_per_sec  # start_sec 이후 남은 길이(원본, 무음 포함)
            keep_segments = build_keep_segments(remaining_dur)

            # keep_segments를 이어붙인 "도려낸 뒤" 타임라인(trimmed) <-> 원본(무음 포함) 절대시간 매핑.
            _keep_cum, _running = [], 0.0
            for _s, _e in keep_segments:
                _keep_cum.append((_running, _running + (_e - _s), _s))
                _running += (_e - _s)
            trimmed_total = _running

            def trimmed_to_orig(t: float) -> float:
                """도려낸 뒤 이어붙인 시간(trimmed) -> 원본(무음 포함) 절대시간으로 되돌림."""
                if not _keep_cum:
                    return t
                for ts, te, os_ in _keep_cum:
                    if t <= te + 1e-6:
                        return os_ + (t - ts)
                ts, te, os_ = _keep_cum[-1]
                return os_ + (t - ts)

            debug_log(f"무음 도려내기: 원본 {remaining_dur:.1f}초 → 실제 변환 {trimmed_total:.1f}초 ({len(keep_segments)}개 구간)")

            def build_chunk_lens(total_dur: float):
                """[(조각 시작초, 조각 길이초), ...] — trimmed 타임라인 기준 CHUNK_SEC 캡으로 균등 분할.
                무음은 이미 도려내졌으므로 여기선 무음 우선 분할이 필요 없다 — 그냥 캡 단위로 자르고
                (문장 중간이 잘릴 수 있으니) 경계마다 겹침+중복제거로 보완한다."""
                lens = []
                pos = 0.0
                while pos < total_dur:
                    this_len = min(CHUNK_SEC, total_dur - pos)
                    lens.append((pos, this_len))
                    pos += this_len
                return lens

            chunk_lens = build_chunk_lens(trimmed_total)
            debug_log(f"조각 분할: {len(chunk_lens)}개, 길이(초)={[round(l,1) for _, l in chunk_lens]}")

            yield "data: " + json.dumps({"type":"status","msg":"AI 변환 중..."}) + "\n\n"

            # ── whisper.cpp 엔진 ──────────────────────────────────────
            if engine == "cpp":
                cpp_exe = get_whisper_cpp_exe()
                if not cpp_exe.exists():
                    debug_log(f"[오류] whisper-cli.exe 없음: {cpp_exe}")
                    yield "data: " + json.dumps({"type":"error","msg":"변환 실행 파일을 찾을 수 없어요. 설정에서 faster-whisper 엔진으로 바꿔보세요."}) + "\n\n"
                    return

                model_path = get_cpp_model_path(model_name)
                if not model_path or not model_path.exists():
                    debug_log(f"[오류] whisper.cpp 모델 없음: {model_name}")
                    yield "data: " + json.dumps({"type":"error","msg":f"설정에서 {model_name} 모델을 먼저 다운로드해주세요."}) + "\n\n"
                    return

                # 모든 파일을 ffmpeg으로 16kHz Mono WAV 변환 (영문 임시경로)
                yield "data: " + json.dumps({"type":"status","msg":"음성 파일 변환 중..."}) + "\n\n"
                try:
                    wav_path = convert_to_wav_eng(tmp_path)
                except Exception as e:
                    debug_log(f"[오류] WAV 변환 실패: {e}")
                    yield "data: " + json.dumps({"type":"error","msg":str(e)}) + "\n\n"
                    return

                # 모델 경로 (이미 영문 경로에 다운됨)
                eng_model = get_cpp_model_path(model_name)

                # Windows에서 검은 창 숨기기 (아래 무음 도려내기 ffmpeg 호출에도 필요해 먼저 준비)
                startupinfo = None
                if os.name == "nt":
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    startupinfo.wShowWindow = subprocess.SW_HIDE

                def extract_chunk_wav(t_start: float, t_end: float) -> str:
                    """트림(무음 도려낸 뒤) 타임라인 구간 [t_start, t_end)를 _keep_cum으로 원본 시간
                    조각(들)로 되돌려 ffmpeg으로 그때그때 잘라 이어붙인다. 전체 파일 분량을 미리
                    한 번에 다 잘라두지 않고 조각(10분)마다 필요한 만큼만 처리해서, 첫 결과가 나오기까지
                    기다리는 시간을 조각별로 분산시킨다(체감 대기시간 단축)."""
                    pieces = []
                    for ts, te, os_ in _keep_cum:
                        seg_s, seg_e = max(t_start, ts), min(t_end, te)
                        if seg_e > seg_s:
                            pieces.append((os_ + (seg_s - ts), os_ + (seg_e - ts)))
                    if not pieces:
                        return None
                    piece_paths = []
                    try:
                        for s, e in pieces:
                            piece_path = str(Path(r"C:\whisper-models") / f"piece_{uuid.uuid4().hex[:8]}.wav")
                            subprocess.run(
                                [get_ffmpeg_exe(), "-y", "-ss", str(start_sec + s), "-t", str(e - s), "-i", wav_path,
                                 "-ar", "16000", "-ac", "1", "-f", "wav", piece_path],
                                capture_output=True, check=True, startupinfo=startupinfo,
                            )
                            piece_paths.append(piece_path)
                        if len(piece_paths) == 1:
                            return piece_paths[0]
                        chunk_wav = str(Path(r"C:\whisper-models") / f"chunk_{uuid.uuid4().hex[:8]}.wav")
                        with wave.open(piece_paths[0], "rb") as w0:
                            params = w0.getparams()
                        with wave.open(chunk_wav, "wb") as out_w:
                            out_w.setparams(params)
                            for p in piece_paths:
                                with wave.open(p, "rb") as w:
                                    out_w.writeframes(w.readframes(w.getnframes()))
                        return chunk_wav
                    finally:
                        if len(piece_paths) > 1:
                            for p in piece_paths:
                                try: os.unlink(p)
                                except Exception: pass

                # 스레드 수 자동 설정 (전체 코어 - 2, 최소 1)
                cpu_count = os.cpu_count() or 4
                thread_count = max(1, cpu_count - 2)
                debug_log(f"whisper.cpp 실행 — CPU {cpu_count}코어, 스레드 {thread_count}개 사용, 모델: {eng_model}")

                # 저사양 PC 경고
                if cpu_count <= 2:
                    debug_log(f"[주의] CPU 코어 수 {cpu_count}개 — 변환 속도가 매우 느릴 수 있음")
                    yield "data: " + json.dumps({"type":"status","msg":f"⚠️ CPU 코어가 {cpu_count}개라 변환 속도가 느릴 수 있어요. 완료될 때까지 기다려주세요."}) + "\n\n"

                pattern = re.compile(r'\[(\d+:\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+)\]\s*(.*)')

                def hms_to_sec(hms: str) -> float:
                    h, m, s = hms.split(":")
                    return int(h)*3600 + int(m)*60 + float(s)

                def run_cpp_chunk(chunk_wav_path: str):
                    """조각 wav 파일 하나를 whisper-cli로 돌려 (start,end,text) 리스트 반환(조각 시작 기준 상대시간).
                    매 조각을 새 프로세스로 돌리므로 조각 간 컨텍스트는 자연히 안 이어짐(faster-whisper의
                    condition_on_previous_text=False와 동등). -mc 0 은 조각 '안'에서도 whisper.cpp 내부
                    30초 윈도우 간 컨텍스트 전달을 끊어 완전히 같은 조건으로 맞춘다."""
                    nonlocal proc
                    cmd = [
                        str(cpp_exe),
                        "-m", str(eng_model),
                        "-f", chunk_wav_path,
                        "-l", "ko",
                        "-t", str(thread_count),
                        "-mc", "0",
                        "-nth", "0.4",  # "말 없음" 판정 완화(기본 0.6) — 무음발 할루시네이션 텍스트 버리기 쉽게
                        "-sns",         # 비언어(non-speech) 토큰 억제
                    ]
                    print(f"[곤글박이] whisper.cpp 실행 (스레드: {thread_count}): {' '.join(cmd)}")
                    proc = subprocess.Popen(
                        cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        startupinfo=startupinfo,
                        cwd=str(cpp_exe.parent),
                    )
                    set_active_proc(proc)
                    segs = []
                    for raw_line in proc.stdout:
                        # 상담 내용 보호: 변환 텍스트는 터미널/로그에 절대 찍지 않는다 (브라우저 SSE로만 전달)
                        m = pattern.match(raw_line.strip())
                        if not m:
                            continue
                        st = hms_to_sec(m.group(1))
                        en = hms_to_sec(m.group(2))
                        text = " ".join(m.group(3).split())
                        if text:
                            segs.append((st, en, text))
                    proc.wait()
                    proc = None
                    set_active_proc(None)
                    return segs

                # cpp는 파일 기반이라 조각(chunk_lens, trimmed 타임라인 기준)마다 extract_chunk_wav로
                # 그때그때 원본 wav_path에서 필요한 부분만 잘라 whisper-cli를 새로 실행한다.
                map_idx, full_text = 0, []
                rep_state = {"last": None, "count": 0}  # 연속 동일문장 반복 필터 상태

                def emit(text, abs_start, abs_end):
                    """확정된 텍스트 한 덩이를 SSE 이벤트(문자열 리스트)로 만든다."""
                    nonlocal map_idx
                    events = []
                    while map_idx < len(silence_map):
                        sil = silence_map[map_idx]
                        if sil["start"] < abs_start - start_sec:
                            if sil["dur"] >= SILENCE_SHOW_MIN:  # 긴 침묵만 표시, 짧은 건 조용히 넘김
                                line = "\n(침묵)\n"
                                full_text.append(line)
                                events.append("data: " + json.dumps({"type":"silence","text":line,"dur":sil["dur"],"progress":round((abs_start/total_duration_sec)*100,1),"start_sec":round(start_sec+sil["start"],2),"end_sec":round(start_sec+sil["end"],2)}) + "\n\n")
                            map_idx += 1
                        else:
                            break
                    # 연속 동일문장 반복 필터(할루시네이션 반복 잔재 제거):
                    # 짧은 맞장구("네","그렇죠" 등 5글자 이하)는 실제로 여러 번 반복하니 4번까지 허용,
                    # 일반 문장은 3번 이상 똑같이 반복하지 않으니 2번까지만 허용.
                    norm = " ".join(text.split())
                    if norm == rep_state["last"]:
                        rep_state["count"] += 1
                        allow = 4 if len(norm) <= 5 else 2
                        if rep_state["count"] > allow:
                            return events  # 침묵 표시는 이미 담겼으니 문장만 버림
                    else:
                        rep_state["last"] = norm
                        rep_state["count"] = 1
                    t_stamp = f"({int(abs_start//60):02d}:{int(abs_start%60):02d}) " if show_time else ""
                    line = f"{t_stamp}{norm}"
                    full_text.append(line + "\n\n")
                    events.append("data: " + json.dumps({"type":"segment","text":line,"progress":round((abs_end/total_duration_sec)*100,1),"start_sec":round(abs_start,2),"end_sec":round(abs_end,2)}) + "\n\n")
                    return events

                def overlap_cut(tail_words, head_words):
                    """겹침 구간 두 단어열 중 가장 길게 일치하는 지점을 찾는다."""
                    sm_ = difflib.SequenceMatcher(None, tail_words, head_words, autojunk=False)
                    match = sm_.find_longest_match(0, len(tail_words), 0, len(head_words))
                    if match.size >= 2:
                        return match.a + match.size, match.b + match.size
                    return None

                pending_tail_text = None
                pending_tail_start = pending_tail_end = 0.0

                for i, (cs, this_len) in enumerate(chunk_lens):
                    if is_cancelled():
                        debug_log(f"[중지] req_id={req_id} 사용자 요청으로 변환 중단 (조각 {i}/{len(chunk_lens)})")
                        yield "data: " + json.dumps({"type":"cancelled"}) + "\n\n"
                        return
                    chunk_offset = cs
                    ce = min(trimmed_total, cs + this_len + OVERLAP_SEC)
                    try:
                        chunk_wav = extract_chunk_wav(cs, ce)
                    except Exception as e:
                        debug_log(f"[오류] 조각 {i} ffmpeg 분할 실패: {e}")
                        continue
                    if chunk_wav is None:
                        continue
                    try:
                        segs = run_cpp_chunk(chunk_wav)
                    finally:
                        try: os.unlink(chunk_wav)
                        except Exception: pass

                    head_segs = [sg for sg in segs if sg[0] <= OVERLAP_SEC]
                    safe_segs = [sg for sg in segs if OVERLAP_SEC < sg[0] < this_len]
                    tail_segs = [sg for sg in segs if sg[0] >= this_len]

                    if pending_tail_text is None:
                        for sg in head_segs:
                            abs_start = start_sec + trimmed_to_orig(chunk_offset + sg[0])
                            abs_end = start_sec + trimmed_to_orig(chunk_offset + sg[1])
                            for ev in emit(sg[2], abs_start, abs_end):
                                yield ev
                    else:
                        head_text = " ".join(sg[2].strip() for sg in head_segs)
                        head_words = head_text.split()
                        cut = overlap_cut(pending_tail_text.split(), head_words) if pending_tail_text else None
                        if cut is not None:
                            tail_cut_idx, head_skip_idx = cut
                            boundary_words = pending_tail_text.split()[:tail_cut_idx] + head_words[head_skip_idx:]
                        else:
                            if pending_tail_text:
                                debug_log(f"[경고] 조각 {i} 경계 겹침 텍스트를 못 찾음 - 겹침 없이 이어붙임")
                            boundary_words = pending_tail_text.split() + head_words
                        boundary_text = " ".join(w for w in boundary_words if w)
                        if boundary_text.strip():
                            abs_start = pending_tail_start if pending_tail_text else (start_sec + trimmed_to_orig(chunk_offset))
                            abs_end = start_sec + trimmed_to_orig(chunk_offset + OVERLAP_SEC)
                            for ev in emit(boundary_text, abs_start, abs_end):
                                yield ev

                    for sg in safe_segs:
                        abs_start = start_sec + trimmed_to_orig(chunk_offset + sg[0])
                        abs_end = start_sec + trimmed_to_orig(chunk_offset + sg[1])
                        for ev in emit(sg[2], abs_start, abs_end):
                            yield ev

                    is_last = (i == len(chunk_lens) - 1)
                    if is_last:
                        for sg in tail_segs:
                            abs_start = start_sec + trimmed_to_orig(chunk_offset + sg[0])
                            abs_end = start_sec + trimmed_to_orig(chunk_offset + sg[1])
                            for ev in emit(sg[2], abs_start, abs_end):
                                yield ev
                        pending_tail_text = None
                    elif tail_segs:
                        pending_tail_text = " ".join(sg[2].strip() for sg in tail_segs)
                        pending_tail_start = start_sec + trimmed_to_orig(chunk_offset + tail_segs[0][0])
                        pending_tail_end = start_sec + trimmed_to_orig(chunk_offset + tail_segs[-1][1])
                    else:
                        pending_tail_text = ""
                        pending_tail_start = pending_tail_end = start_sec + trimmed_to_orig(chunk_offset + this_len)

                debug_log(f"whisper.cpp 변환 완료 (조각 {len(chunk_lens)}개)")
                yield "data: " + json.dumps({"type":"done","full_text":"".join(full_text)}) + "\n\n"

            # ── faster-whisper 엔진 (기존) ────────────────────────────
            else:
                try:
                    model = get_model(model_name)
                except Exception as e:
                    debug_log(f"[오류] faster-whisper 모델 로드 실패 ({model_name}): {e}")
                    try:
                        import psutil
                        ram_avail = psutil.virtual_memory().available // (1024 ** 3)
                        debug_log(f"  현재 여유 RAM: {ram_avail}GB")
                        if ram_avail < 2:
                            msg = "메모리가 부족해요. 다른 프로그램을 모두 닫고 다시 시도해보세요. 그래도 안 되면 설정에서 Small 모델로 바꿔보세요."
                        else:
                            msg = "모델을 불러오지 못했어요. 모델 파일이 손상됐을 수 있어요. 설정에서 해당 모델을 삭제 후 다시 다운로드해보세요."
                    except Exception:
                        msg = "모델을 불러오지 못했어요. 다른 프로그램을 닫고 다시 시도하거나, 설정에서 Small 모델로 바꿔보세요."
                    yield "data: " + json.dumps({"type":"error","msg":msg}) + "\n\n"
                    return

                # 무음 도려낸 뒤 이어붙인 오디오(trimmed_audio) 위에서 chunk_lens(엔진 공통 계산)대로 순차 변환.
                # 조각 경계(겹침 구간)는 다음 조각이 끝나야 중복 제거가 확정되므로 그때까지 보류했다가 확정되면 내보낸다.
                if len(keep_segments) <= 1 and (not keep_segments or keep_segments[0] == (0.0, remaining_dur)):
                    trimmed_audio = audio
                else:
                    trimmed_audio = np.concatenate([
                        audio[int(s * samples_per_sec):int(e * samples_per_sec)] for s, e in keep_segments
                    ])

                map_idx, full_text = 0, []
                rep_state = {"last": None, "count": 0}  # 연속 동일문장 반복 필터 상태

                def emit(text, abs_start, abs_end):
                    """확정된 텍스트 한 덩이를 SSE 이벤트(문자열 리스트)로 만든다."""
                    nonlocal map_idx
                    events = []
                    while map_idx < len(silence_map):
                        sil = silence_map[map_idx]
                        if sil["start"] < abs_start - start_sec:
                            if sil["dur"] >= SILENCE_SHOW_MIN:  # 긴 침묵만 표시, 짧은 건 조용히 넘김
                                line = "\n(침묵)\n"
                                full_text.append(line)
                                events.append("data: " + json.dumps({"type":"silence","text":line,"dur":sil["dur"],"progress":round((abs_start/total_duration_sec)*100,1),"start_sec":round(start_sec+sil["start"],2),"end_sec":round(start_sec+sil["end"],2)}) + "\n\n")
                            map_idx += 1
                        else:
                            break
                    # 연속 동일문장 반복 필터(할루시네이션 반복 잔재 제거):
                    # 짧은 맞장구("네","그렇죠" 등 5글자 이하)는 실제로 여러 번 반복하니 4번까지 허용,
                    # 일반 문장은 3번 이상 똑같이 반복하지 않으니 2번까지만 허용.
                    norm = " ".join(text.split())
                    if norm == rep_state["last"]:
                        rep_state["count"] += 1
                        allow = 4 if len(norm) <= 5 else 2
                        if rep_state["count"] > allow:
                            return events  # 침묵 표시는 이미 담겼으니 문장만 버림
                    else:
                        rep_state["last"] = norm
                        rep_state["count"] = 1
                    t_stamp = f"({int(abs_start//60):02d}:{int(abs_start%60):02d}) " if show_time else ""
                    line = f"{t_stamp}{norm}"
                    full_text.append(line + "\n\n")
                    events.append("data: " + json.dumps({"type":"segment","text":line,"progress":round((abs_end/total_duration_sec)*100,1),"start_sec":round(abs_start,2),"end_sec":round(abs_end,2)}) + "\n\n")
                    return events

                def overlap_cut(tail_words, head_words):
                    """겹침 구간 두 단어열 중 가장 길게 일치하는 지점을 찾는다.
                    (이전 조각에서 몇 번째 단어까지가 확정인지, 다음 조각은 몇 번째 단어부터가 새 내용인지)"""
                    sm_ = difflib.SequenceMatcher(None, tail_words, head_words, autojunk=False)
                    match = sm_.find_longest_match(0, len(tail_words), 0, len(head_words))
                    if match.size >= 2:
                        return match.a + match.size, match.b + match.size
                    return None

                pending_tail_text = None   # 이전 조각의 겹침구간(확정 대기) 텍스트. None=이전 조각 없음(첫 조각)
                pending_tail_start = pending_tail_end = 0.0

                for i, (pos, this_len) in enumerate(chunk_lens):
                    if is_cancelled():
                        debug_log(f"[중지] req_id={req_id} 사용자 요청으로 변환 중단 (조각 {i}/{len(chunk_lens)})")
                        yield "data: " + json.dumps({"type":"cancelled"}) + "\n\n"
                        return
                    chunk_offset = pos
                    s = int(pos * samples_per_sec)
                    e = min(len(trimmed_audio), int((pos + this_len + OVERLAP_SEC) * samples_per_sec))
                    segs_gen, _info = model.transcribe(
                        trimmed_audio[s:e], beam_size=5, language="ko",
                        condition_on_previous_text=False,
                    )
                    segs = list(segs_gen)

                    head_segs = [sg for sg in segs if sg.start <= OVERLAP_SEC]
                    safe_segs = [sg for sg in segs if OVERLAP_SEC < sg.start < this_len]
                    tail_segs = [sg for sg in segs if sg.start >= this_len]

                    if pending_tail_text is None:
                        # 첫 조각: 비교할 이전 조각이 없으므로 앞부분(head)도 그대로 출력
                        for sg in head_segs:
                            abs_start = start_sec + trimmed_to_orig(chunk_offset + sg.start)
                            abs_end = start_sec + trimmed_to_orig(chunk_offset + sg.end)
                            for ev in emit(sg.text, abs_start, abs_end):
                                yield ev
                    else:
                        head_text = " ".join(sg.text.strip() for sg in head_segs)
                        head_words = head_text.split()
                        cut = overlap_cut(pending_tail_text.split(), head_words) if pending_tail_text else None
                        if cut is not None:
                            tail_cut_idx, head_skip_idx = cut
                            boundary_words = pending_tail_text.split()[:tail_cut_idx] + head_words[head_skip_idx:]
                        else:
                            if pending_tail_text:
                                debug_log(f"[경고] 조각 {i} 경계 겹침 텍스트를 못 찾음 - 겹침 없이 이어붙임")
                            boundary_words = pending_tail_text.split() + head_words
                        boundary_text = " ".join(w for w in boundary_words if w)
                        if boundary_text.strip():
                            abs_start = pending_tail_start if pending_tail_text else (start_sec + trimmed_to_orig(chunk_offset))
                            abs_end = start_sec + trimmed_to_orig(chunk_offset + OVERLAP_SEC)
                            for ev in emit(boundary_text, abs_start, abs_end):
                                yield ev

                    for sg in safe_segs:
                        abs_start = start_sec + trimmed_to_orig(chunk_offset + sg.start)
                        abs_end = start_sec + trimmed_to_orig(chunk_offset + sg.end)
                        for ev in emit(sg.text, abs_start, abs_end):
                            yield ev

                    is_last = (i == len(chunk_lens) - 1)
                    if is_last:
                        for sg in tail_segs:
                            abs_start = start_sec + trimmed_to_orig(chunk_offset + sg.start)
                            abs_end = start_sec + trimmed_to_orig(chunk_offset + sg.end)
                            for ev in emit(sg.text, abs_start, abs_end):
                                yield ev
                        pending_tail_text = None
                    elif tail_segs:
                        pending_tail_text = " ".join(sg.text.strip() for sg in tail_segs)
                        pending_tail_start = start_sec + trimmed_to_orig(chunk_offset + tail_segs[0].start)
                        pending_tail_end = start_sec + trimmed_to_orig(chunk_offset + tail_segs[-1].end)
                    else:
                        pending_tail_text = ""
                        pending_tail_start = pending_tail_end = start_sec + trimmed_to_orig(chunk_offset + this_len)

                yield "data: " + json.dumps({"type":"done","full_text":"".join(full_text)}) + "\n\n"
                debug_log(f"faster-whisper 변환 완료 (조각 {len(chunk_lens)}개)")

        except Exception as e:
            traceback.print_exc()
            debug_log(f"[오류] 변환 중 예외 발생: {e}")
            yield "data: " + json.dumps({"type":"error","msg":"예기치 못한 오류가 발생했어요. 앱을 재실행 후 다시 시도해보세요."}) + "\n\n"
        finally:
            # ③ 좀비 프로세스 방지 — whisper-cli/ffmpeg 강제 종료
            if proc is not None:
                try:
                    if proc.poll() is None:  # 아직 실행 중이면
                        proc.kill()
                        proc.wait()
                except Exception:
                    pass

            # ② 임시 파일 확실한 삭제 (상담 파일 보안)
            for path in {tmp_path, wav_path}:
                if path:
                    try: os.unlink(path)
                    except: pass

            # ④ 요청 추적 해제 — 중지 버튼이 이미 끝난 요청을 붙잡고 있지 않도록
            with ACTIVE_JOBS_LOCK:
                ACTIVE_JOBS.pop(req_id, None)

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})

_HWPX_NS = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}

def _hwpx_extract_table(tbl):
    """hp:tbl 하나를 rowCnt x colCnt 2차원 배열(텍스트)로 변환. 병합 셀은 첫 칸에만 값을 두고 나머지는 빈 문자열."""
    import xml.etree.ElementTree as ET
    row_cnt = int(tbl.get("rowCnt", "0"))
    col_cnt = int(tbl.get("colCnt", "0"))
    grid = [["" for _ in range(col_cnt)] for _ in range(row_cnt)]
    for tc in tbl.findall("./hp:tr/hp:tc", _HWPX_NS):
        addr = tc.find("hp:cellAddr", _HWPX_NS)
        if addr is None:
            continue
        r, c = int(addr.get("rowAddr", "0")), int(addr.get("colAddr", "0"))
        if r >= row_cnt or c >= col_cnt:
            continue
        text = "".join((t.text or "") for t in tc.findall(".//hp:t", _HWPX_NS))
        grid[r][c] = text
    return grid

def _hwpx_extract_preview(path: str):
    """hwpx 문서를 읽기 전용 미리보기용으로 파싱 — 단락/표를 문서 순서대로 blocks 배열에 담아 반환.
    폰트·줄간격 같은 정밀 서식은 재현하지 않음(참고용 읽기 목적). 옛 .hwp 바이너리는 지원 안 함."""
    import xml.etree.ElementTree as ET
    blocks = []
    with zipfile.ZipFile(path) as z:
        section_names = sorted(n for n in z.namelist() if re.match(r"^Contents/section\d+\.xml$", n))
        if not section_names:
            raise ValueError("hwpx 안에 section XML이 없습니다")
        for name in section_names:
            root = ET.fromstring(z.read(name))
            for p in root.findall("hp:p", _HWPX_NS):
                tbl = p.find(".//hp:tbl", _HWPX_NS)
                if tbl is not None:
                    blocks.append({"type": "table", "rows": _hwpx_extract_table(tbl)})
                    continue
                text = "".join((t.text or "") for t in p.findall(".//hp:t", _HWPX_NS))
                if text.strip():
                    blocks.append({"type": "text", "text": text})
    return blocks

def _fill_observer_report(form_path: str, out_path: str, date: str, affiliation: str, name: str, sections: dict):
    """참관자 보고서 채우기 — 양식(hwpx)의 머리줄(참관일/소속/이름)을 교체하고,
    각 섹션 제목 문단 바로 아래에 작성 내용을 문단으로 끼워 넣어 저장한다.
    원본 양식은 건드리지 않고 새 파일로 저장. 서식은 양식의 문단 서식을 복제해 유지."""
    import copy
    import zipfile as zflib
    from lxml import etree
    NSP = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}

    with zflib.ZipFile(form_path) as z:
        names = z.namelist()
        data = {n: z.read(n) for n in names}
    root = etree.fromstring(data["Contents/section0.xml"])

    def ptext(p):
        return "".join(t.text or "" for t in p.findall(".//hp:t", NSP))

    def set_text(p, line):
        ts = p.findall(".//hp:t", NSP)
        if ts:
            ts[0].text = line
            for t in ts[1:]:
                t.text = ""
        else:
            # 빈 문단엔 텍스트 요소가 없음 — 만들어서 넣는다(빈 칸 미채움 버그 방지)
            run = p.find(".//hp:run", NSP)
            if run is None:
                return
            t = etree.SubElement(run, "{http://www.hancom.co.kr/hwpml/2011/paragraph}t")
            t.text = line
        # 줄 배치 캐시를 지워 한글이 새로 계산하게 함(겹침 방지 — linesegarray 함정)
        for seg in p.findall("hp:linesegarray", NSP):
            p.remove(seg)

    # 본문 스타일 문단 하나를 복제 원본으로 확보 — "(예시)" 문단이 있으면 그것(일반 본문 서식)
    body_proto = None
    for p in root.findall("hp:p", NSP):
        if ptext(p).strip().startswith("(예시)") and p.findall(".//hp:t", NSP):
            body_proto = p
            break

    # 1) 머리줄 교체
    for p in root.findall("hp:p", NSP):
        if ptext(p).strip().startswith("참관일"):
            set_text(p, f"참관일: {date} / 소 속: {affiliation} / 이 름: {name}")
            break

    # 2) 섹션 내용 삽입 — 제목 문단 바로 뒤에, 줄 단위 문단으로
    for heading, content in (sections or {}).items():
        if not (content or "").strip():
            continue
        for p in root.findall("hp:p", NSP):
            if ptext(p).strip() == heading:
                proto = body_proto if body_proto is not None else p
                anchor = p
                for line in (content.strip().splitlines() or [""]):
                    np_ = copy.deepcopy(proto)
                    set_text(np_, line)
                    anchor.addnext(np_)
                    anchor = np_
                break

    data["Contents/section0.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    # mimetype은 반드시 첫 엔트리 + 무압축(STORED) — hwpx 불변식
    with zflib.ZipFile(out_path, "w") as zout:
        zout.writestr("mimetype", data["mimetype"], compress_type=zflib.ZIP_STORED)
        for n in names:
            if n == "mimetype":
                continue
            zout.writestr(n, data[n], compress_type=zflib.ZIP_DEFLATED)

_HWPX_NSP = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}

def _hwpx_load_root(form_path):
    import zipfile as zflib
    from lxml import etree
    with zflib.ZipFile(form_path) as z:
        return etree.fromstring(z.read("Contents/section0.xml"))

def _cell_text(tc):
    return "".join(t.text or "" for t in tc.findall(".//hp:t", _HWPX_NSP))

def _cell_plain_text(tc):
    """셀의 '일반 문단'만 모은 텍스트 — 셀 안에 중첩된 표(예: SCT 예시표)의 글자는 제외."""
    out = []
    sub = tc.find("hp:subList", _HWPX_NSP)
    if sub is None:
        return ""
    for p in sub.findall("hp:p", _HWPX_NSP):
        if p.find(".//hp:tbl", _HWPX_NSP) is not None:
            continue
        out.append("".join(t.text or "" for t in p.findall(".//hp:t", _HWPX_NSP)))
    return "\n".join(x for x in out if x.strip())

def _find_psych_layout(root):
    """심리평가형(표 기반) 양식 인식 — '1. 제목 | 안내문' 2열 표와 라벨/값 머리표를 찾는다.
    반환: (섹션표, [{title, guide}], 머리표, [라벨들]) 또는 (None, None, None, None)."""
    import re as _re
    section_tbl, sections = None, None
    header_tbl, header_labels = None, None
    for tbl in root.findall(".//hp:tbl", _HWPX_NSP):
        rows = {}
        for tc in tbl.findall("./hp:tr/hp:tc", _HWPX_NSP):
            addr = tc.find("hp:cellAddr", _HWPX_NSP)
            rows.setdefault(int(addr.get("rowAddr")), {})[int(addr.get("colAddr"))] = tc
        if tbl.get("colCnt") == "2" and section_tbl is None:
            cand = []
            for r in sorted(rows):
                c0 = rows[r].get(0); c1 = rows[r].get(1)
                if c0 is None or c1 is None:
                    continue
                title = _cell_text(c0).strip()
                if _re.match(r"^\d+\.\s*\S", title):
                    cand.append({"title": title, "guide": _cell_plain_text(c1).strip()})
            if len(cand) >= 5:  # 번호 달린 항목이 여럿이면 심리평가형 섹션표로 판단
                section_tbl, sections = tbl, cand
        # 머리표: 짝수 열(라벨|값 반복) 구조에서 라벨 셀들 수집
        if header_tbl is None and tbl.get("colCnt") in ("4", "6") and int(tbl.get("rowCnt", "0")) <= 4:
            labels = []
            for r in sorted(rows):
                for c in sorted(rows[r]):
                    if c % 2 == 0:
                        lbl = _cell_text(rows[r][c]).strip()
                        if lbl:
                            labels.append(lbl)
            if len(labels) >= 4:
                header_tbl, header_labels = tbl, labels
    return section_tbl, sections, header_tbl, header_labels

@app.post("/api/report/template-sections")
def report_template_sections():
    """양식(hwpx)을 분석해 작성칸 구성을 반환 — 화면이 이걸로 폼을 만든다.
    ①표 기반(심리평가형): '1. 제목|안내문' 2열 표 → 각 항목 제목+가이드, 머리표 라벨들
    ②문단형(참관자형): 짧은 문단(25자 이하)을 섹션 제목으로 간주."""
    d = request.get_json(silent=True) or {}
    form = d.get("form_path", "")
    if not form.lower().endswith(".hwpx") or not Path(form).exists():
        return jsonify(ok=False, error="양식(hwpx) 파일을 찾을 수 없어요."), 400
    try:
        root = _hwpx_load_root(form)

        # ① 표 기반(심리평가형) 우선 인식
        _, sections, _, header_labels = _find_psych_layout(root)
        if sections:
            return jsonify(ok=True, type="table", sections=sections, header_labels=header_labels or [])

        # ② 문단형(참관자형)
        plist, has_header = [], False
        for p in root.findall("hp:p", _HWPX_NSP):
            txt = "".join(t.text or "" for t in p.findall(".//hp:t", _HWPX_NSP)).strip()
            if not txt:
                continue
            if txt.startswith("참관일"):
                has_header = True
                continue
            if txt.startswith("<") or txt.startswith("("):
                continue
            if len(txt) <= 25 and txt not in [s["title"] for s in plist]:
                plist.append({"title": txt, "guide": ""})
        if not plist:
            return jsonify(ok=False, error="이 양식에서 작성칸을 찾지 못했어요. 문단형(제목 아래 내용) 또는 심리평가형(번호 항목 표) 양식만 지원해요.")
        return jsonify(ok=True, type="paragraph", sections=plist, has_header=has_header)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

def _fill_table_report(form_path: str, out_path: str, header: dict, sections: dict):
    """심리평가형(표 기반) 보고서 채우기 — 머리표의 라벨 옆 칸에 값을 넣고,
    각 항목 행의 안내문 칸을 작성 내용으로 교체한다(내용을 안 쓴 항목은 안내문 유지).
    셀 안에 중첩된 표(SCT 예시표·그림검사표)는 그대로 보존 — 표 구조 전체 유지."""
    import copy
    import zipfile as zflib
    from lxml import etree
    NSP = _HWPX_NSP

    with zflib.ZipFile(form_path) as z:
        names = z.namelist()
        data = {n: z.read(n) for n in names}
    root = etree.fromstring(data["Contents/section0.xml"])

    section_tbl, found, header_tbl, _ = _find_psych_layout(root)
    if section_tbl is None:
        raise ValueError("이 양식에서 항목 표를 찾지 못했어요.")

    def set_para_text(p, line):
        ts = p.findall(".//hp:t", NSP)
        if ts:
            ts[0].text = line
            for t in ts[1:]:
                t.text = ""
        else:
            # 빈 셀 문단엔 텍스트 요소가 아예 없음 — 만들어서 넣는다
            # (이거 없으면 빈 칸이 조용히 안 채워지는 버그, 2026-07-10 실측)
            run = p.find(".//hp:run", NSP)
            if run is None:
                return
            t = etree.SubElement(run, "{http://www.hancom.co.kr/hwpml/2011/paragraph}t")
            t.text = line
        for seg in p.findall("hp:linesegarray", NSP):
            p.remove(seg)

    # 1) 머리표 — 라벨 셀 바로 오른쪽 칸에 값
    if header_tbl is not None and header:
        rows = {}
        for tc in header_tbl.findall("./hp:tr/hp:tc", NSP):
            addr = tc.find("hp:cellAddr", NSP)
            rows.setdefault(int(addr.get("rowAddr")), {})[int(addr.get("colAddr"))] = tc
        for r in rows:
            for c in rows[r]:
                lbl = _cell_text(rows[r][c]).strip()
                if lbl in header and (header[lbl] or "").strip():
                    val_tc = rows[r].get(c + 1)
                    if val_tc is not None:
                        ps = val_tc.findall(".//hp:p", NSP)
                        if ps:
                            set_para_text(ps[0], header[lbl].strip())

    # 2) 항목 행 — 왼쪽 제목이 일치하는 행의 오른쪽 칸을 작성 내용으로 교체
    rows = {}
    for tc in section_tbl.findall("./hp:tr/hp:tc", NSP):
        addr = tc.find("hp:cellAddr", NSP)
        rows.setdefault(int(addr.get("rowAddr")), {})[int(addr.get("colAddr"))] = tc
    for r in sorted(rows):
        c0, c1 = rows[r].get(0), rows[r].get(1)
        if c0 is None or c1 is None:
            continue
        title = _cell_text(c0).strip()
        content = (sections or {}).get(title, "")
        if not (content or "").strip():
            continue  # 안 쓴 항목은 안내문 그대로 둠
        sub = c1.find("hp:subList", NSP)
        if sub is None:
            continue
        plain = [p for p in sub.findall("hp:p", NSP) if p.find(".//hp:tbl", NSP) is None]
        keep_tbl = [p for p in sub.findall("hp:p", NSP) if p.find(".//hp:tbl", NSP) is not None]
        proto = copy.deepcopy(plain[0]) if plain else None
        for p in plain:  # 안내문(일반 문단) 제거 — 중첩 표 문단은 보존
            sub.remove(p)
        if proto is None:
            continue
        lines = content.strip().splitlines() or [""]
        for idx, line in enumerate(lines):
            np_ = copy.deepcopy(proto)
            set_para_text(np_, line)
            sub.insert(idx, np_)
        _ = keep_tbl  # 중첩 표는 subList에 그대로 남아 있음

    data["Contents/section0.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with zflib.ZipFile(out_path, "w") as zout:
        zout.writestr("mimetype", data["mimetype"], compress_type=zflib.ZIP_STORED)
        for n in names:
            if n == "mimetype":
                continue
            zout.writestr(n, data[n], compress_type=zflib.ZIP_DEFLATED)

@app.post("/api/report/observer")
def report_observer():
    """보고서 생성 — 사례연구 책상의 보고서 작성칸이 호출. 양식 구조를 다시 판별해
    표 기반(심리평가형)이면 표 채우기, 아니면 문단형(참관자형) 채우기."""
    d = request.get_json(silent=True) or {}
    form = d.get("form_path", "")
    out_path = d.get("out_path", "")
    if not form.lower().endswith(".hwpx") or not Path(form).exists():
        return jsonify(ok=False, error="양식(hwpx) 파일을 찾을 수 없어요. 양식을 다시 선택해주세요."), 400
    if not out_path:
        return jsonify(ok=False, error="저장 경로가 없어요."), 400
    try:
        root = _hwpx_load_root(form)
        tbl, _, _, _ = _find_psych_layout(root)
        if tbl is not None:
            _fill_table_report(form, out_path, d.get("header") or {}, d.get("sections") or {})
        else:
            _fill_observer_report(form, out_path, d.get("date", ""), d.get("affiliation", ""),
                                  d.get("name", ""), d.get("sections") or {})
        debug_log(f"보고서 생성 완료: {Path(out_path).name}")
        return jsonify(ok=True, path=out_path)
    except Exception as e:
        debug_log(f"[오류] 보고서 생성 실패: {type(e).__name__}")
        return jsonify(ok=False, error=str(e)), 500

@app.post("/api/file/hwpx-preview")
def hwpx_preview():
    """hwpx 파일을 읽기 전용으로 미리보기 — 사례서랍에서 hwpx 첨부를 앱 안에서 펼쳐볼 때 사용."""
    data = request.get_json(silent=True) or {}
    path = data.get("path", "")
    if not path or not path.lower().endswith(".hwpx"):
        return jsonify(ok=False, error="hwpx 파일 경로가 아닙니다"), 400
    try:
        blocks = _hwpx_extract_preview(path)
        return jsonify(ok=True, blocks=blocks)
    except zipfile.BadZipFile:
        return jsonify(ok=False, error="hwpx 파일이 손상되었거나 올바른 형식이 아닙니다")
    except Exception as e:
        return jsonify(ok=False, error=str(e))

def _no_cache(resp):
    # 화면 파일(assets/index.js 등)이 빌드마다 같은 이름으로 나오기 때문에,
    # 캐싱을 허용하면 업데이트해도 Electron이 예전 화면을 그대로 보여주는
    # 사고가 난다(2026-07-09 실측). 로컬 전용 앱이라 캐시로 얻을 성능 이득도
    # 없으므로 아예 꺼버린다.
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    return resp

@app.get("/")
def index():
    return _no_cache(send_from_directory(UI_DIR, "index.html"))

@app.get("/<path:p>")
def static_files(p):
    target = UI_DIR / p
    return _no_cache(send_from_directory(UI_DIR, p if target.exists() else "index.html"))

def open_browser(port):
    time.sleep(1.0)
    webbrowser.open(f"http://127.0.0.1:{port}")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5577"))
    print("=" * 60)
    print("  곤글박이가 시작되었습니다.")
    print(f"  브라우저: http://127.0.0.1:{port}")
    print(f"  실행 모드: {DEVICE.upper()}")
    print("  (이 창을 닫지 마세요)")
    print("=" * 60)
    # Electron에서 실행 중이면 브라우저 자동 열기 생략
    if not os.environ.get("ELECTRON"):
        threading.Thread(target=open_browser, args=(port,), daemon=True).start()
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False, threaded=True)
