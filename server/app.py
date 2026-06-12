"""
곤글박이 - 로컬 서버 v2
- faster-whisper (실시간 스트리밍)
- GPU 자동 감지
- 침묵 구간 자동 감지
"""
import os, tempfile, threading, webbrowser, time, traceback, shutil, json
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

app = Flask(__name__, static_folder=str(UI_DIR), static_url_path="")
CORS(app, resources={r"/api/*": {"origins": "*"}})

_models = {}

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
}

CPP_MODEL_URLS = {
    "small":    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    "medium":   "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    "large-v3": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
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
    for name in ("small", "medium", "large-v3"):
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

    def generate():
        yield "data: " + json.dumps({"type": "start", "model": name}) + "\n\n"
        t = threading.Thread(target=do_download, daemon=True)
        t.start()
        while True:
            try:
                result = q.get(timeout=5)
                yield "data: " + json.dumps(result) + "\n\n"
                break
            except queue.Empty:
                yield "data: " + json.dumps({"type": "ping"}) + "\n\n"

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
            ["ffmpeg", "-y", "-i", src_path,
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

@app.post("/api/transcribe")
def transcribe():
    if "file" not in request.files:
        return jsonify(error="file 필요"), 400
    model_name = request.form.get("model", "medium")
    if model_name not in ("small", "medium", "large-v3"):
        model_name = "medium"
    engine = request.form.get("engine", "python")  # "python" or "cpp"
    show_time = request.form.get("show_time", "false").lower() == "true"
    start_sec = float(request.form.get("start_sec", "0"))

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
        import json, re, subprocess
        wav_path = None
        proc = None  # 좀비 프로세스 방지용
        try:
            from faster_whisper import decode_audio

            debug_log(f"변환 시작 — 엔진: {engine}, 모델: {model_name}, 파일: {suffix}")

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

                # 스레드 수 자동 설정 (전체 코어 - 2, 최소 1)
                cpu_count = os.cpu_count() or 4
                thread_count = max(1, cpu_count - 2)
                debug_log(f"whisper.cpp 실행 — CPU {cpu_count}코어, 스레드 {thread_count}개 사용, 모델: {eng_model}")

                # 저사양 PC 경고
                if cpu_count <= 2:
                    debug_log(f"[주의] CPU 코어 수 {cpu_count}개 — 변환 속도가 매우 느릴 수 있음")
                    yield "data: " + json.dumps({"type":"status","msg":f"⚠️ CPU 코어가 {cpu_count}개라 변환 속도가 느릴 수 있어요. 완료될 때까지 기다려주세요."}) + "\n\n"

                # whisper-cli 실행 (실시간 readline)
                cmd = [
                    str(cpp_exe),
                    "-m", str(eng_model),
                    "-f", wav_path,
                    "-l", "ko",
                    "-pp",
                    "-t", str(thread_count),
                ]
                print(f"[곤글박이] whisper.cpp 실행 (스레드: {thread_count}): {' '.join(cmd)}")

                # Windows에서 검은 창 숨기기
                startupinfo = None
                if os.name == "nt":
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    startupinfo.wShowWindow = subprocess.SW_HIDE

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

                full_text = []
                map_idx = 0
                pattern = re.compile(r'\[(\d+:\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+)\]\s*(.*)')

                def hms_to_sec(hms: str) -> float:
                    h, m, s = hms.split(":")
                    return int(h)*3600 + int(m)*60 + float(s)

                # 실시간으로 한 줄씩 읽어서 SSE 전송
                while True:
                    raw_line = proc.stdout.readline()
                    if raw_line == "" and proc.poll() is not None:
                        break
                    if not raw_line:
                        continue
                    print(f"[cpp] {raw_line.rstrip()}")  # 터미널에도 실시간 출력
                    m = pattern.match(raw_line.strip())
                    if not m:
                        continue
                    seg_start = hms_to_sec(m.group(1)) + start_sec
                    seg_end   = hms_to_sec(m.group(2)) + start_sec
                    text      = m.group(3).strip()
                    if not text:
                        continue

                    # 침묵 구간 삽입
                    while map_idx < len(silence_map):
                        sm = silence_map[map_idx]
                        if sm["start"] < seg_start - start_sec:
                            sline = f"\n(침묵 {sm['dur']}초)\n"
                            full_text.append(sline)
                            yield "data: " + json.dumps({"type":"silence","text":sline,"dur":sm["dur"],"progress":round((seg_start/total_duration_sec)*100,1),"start_sec":round(start_sec+sm["start"],2),"end_sec":round(start_sec+sm["end"],2)}) + "\n\n"
                            map_idx += 1
                        else:
                            break

                    t_stamp = f"({int(seg_start//60):02d}:{int(seg_start%60):02d}) " if show_time else ""
                    out_line = f"{t_stamp}{text}"
                    full_text.append(out_line + "\n\n")
                    yield "data: " + json.dumps({"type":"segment","text":out_line,"progress":round((seg_end/total_duration_sec)*100,1),"start_sec":round(seg_start,2),"end_sec":round(seg_end,2)}) + "\n\n"

                proc.wait()
                debug_log(f"whisper.cpp 변환 완료")
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

                segments, info = model.transcribe(audio, beam_size=5, language="ko")
                map_idx, full_text = 0, []

                for seg in segments:
                    while map_idx < len(silence_map):
                        sm = silence_map[map_idx]
                        if sm["start"] < seg.start:
                            line = f"\n(침묵 {sm['dur']}초)\n"
                            full_text.append(line)
                            abs_pos = start_sec + seg.start
                            yield "data: " + json.dumps({"type":"silence","text":line,"dur":sm["dur"],"progress":round((abs_pos/total_duration_sec)*100,1),"start_sec":round(start_sec+sm["start"],2),"end_sec":round(start_sec+sm["end"],2)}) + "\n\n"
                            map_idx += 1
                        else:
                            break
                    abs_start = start_sec + seg.start
                    abs_end   = start_sec + seg.end
                    t_stamp = f"({int(abs_start//60):02d}:{int(abs_start%60):02d}) " if show_time else ""
                    line = f"{t_stamp}{seg.text.strip()}"
                    full_text.append(line + "\n\n")
                    yield "data: " + json.dumps({"type":"segment","text":line,"progress":round((abs_end/total_duration_sec)*100,1),"start_sec":round(abs_start,2),"end_sec":round(abs_end,2)}) + "\n\n"

                yield "data: " + json.dumps({"type":"done","full_text":"".join(full_text)}) + "\n\n"
                debug_log(f"faster-whisper 변환 완료")

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
            for path in [tmp_path, wav_path]:
                if path:
                    try: os.unlink(path)
                    except: pass

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})

@app.get("/")
def index():
    return send_from_directory(UI_DIR, "index.html")

@app.get("/<path:p>")
def static_files(p):
    target = UI_DIR / p
    return send_from_directory(UI_DIR, p if target.exists() else "index.html")

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
