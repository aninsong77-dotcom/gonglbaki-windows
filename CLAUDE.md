# 곤글박이 (Gongulbaki) — CLAUDE.md

## 프로젝트 개요

**곤글박이**는 상담학과 학생·수련생·상담사를 위한 **로컬 전용 음성 텍스트 변환(축어록) Electron 데스크탑 앱**이다.

- 이름 유래: 순우리말 새 이름 "곤줄박이"에서 따와 "검은 글자(글)를 새긴다"는 의미
- 핵심 원칙: **온디바이스(On-Device)** — 음성·텍스트가 외부 서버로 전송되지 않고 사용자 PC 안에서만 처리

---

## 기술 스택

| 계층 | 기술 |
|------|------|
| 데스크탑 쉘 | Electron 36 (`electron-main.cjs`) |
| 프론트엔드 | React 18 + TypeScript + Vite + TailwindCSS + Radix UI (shadcn/ui) |
| 백엔드 | Python Flask (포트 5577, `server/app.py`) |
| AI 엔진 | faster-whisper (Python/CUDA) + whisper.cpp (C++) |
| 문서 저장 | `docx` 라이브러리 → `.docx` / `.txt` |
| 패키징 | electron-builder → NSIS 인스톨러 (`release/`) |

---

## 파일 구조

```
gongulbaki/
├── CLAUDE.md                  # 이 파일
├── electron-main.cjs          # Electron 메인 프로세스
│                              #   - Python 백엔드 서버 spawn
│                              #   - 스플래시 → 메인 창 전환 (페이드인)
│                              #   - 창 최소화/최대화/닫기 IPC 처리
├── preload.cjs                # contextBridge (렌더러 ↔ 메인 IPC)
├── splash.html                # 시작 스플래시 화면 (모델 다운로드 진행 표시)
├── index.html                 # Vite 진입점
├── package.json               # 의존성 + electron-builder 빌드 설정
├── vite.config.ts             # Vite 설정 (포트 5577 → Electron 로드)
├── tailwind.config.ts         # TailwindCSS 설정
│
├── src/
│   ├── main.tsx               # React 앱 진입점 (ReactDOM.createRoot)
│   ├── index.css              # 전역 스타일
│   ├── assets/
│   │   ├── gongulbaki-icon.ico
│   │   └── gongulbaki-logo.png
│   ├── pages/
│   │   ├── Index.tsx          # 축어록 메인 UI (~1900줄)
│   │   └── Genogram.tsx       # 가계도 에디터
│   ├── components/ui/         # Radix 기반 shadcn/ui 컴포넌트
│   │   ├── button.tsx
│   │   ├── card.tsx
│   │   ├── dialog.tsx
│   │   ├── input.tsx
│   │   ├── label.tsx
│   │   ├── select.tsx
│   │   └── slider.tsx
│   └── lib/
│       └── utils.ts           # cn() 유틸
│
├── server/
│   ├── app.py                 # Flask 백엔드 (API 전체)
│   ├── requirements.txt       # Python 의존성
│   ├── app.spec               # PyInstaller 빌드 스펙
│   └── build/app/app.exe      # PyInstaller로 패키징된 서버 실행파일
│
├── resources/server/          # electron-builder extraResources 복사 대상
│
├── dist/                      # Vite 빌드 결과물
├── release/                   # electron-builder 출력 (인스톨러)
│
├── whisper-cli.exe            # whisper.cpp 변환 실행파일
├── whisper.dll / ggml*.dll    # whisper.cpp 네이티브 라이브러리
└── public/                    # 정적 자산
```

---

## 백엔드 API (`server/app.py`, 포트 5577)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/health` | 서버 상태 확인 |
| GET | `/api/models/status` | faster-whisper 모델 캐시/로드 상태 |
| GET | `/api/models/download/<name>` | faster-whisper 모델 다운로드 (SSE) |
| DELETE | `/api/models/delete/<name>` | faster-whisper 모델 삭제 |
| GET | `/api/models/cpp/status` | whisper.cpp 모델 상태 |
| GET | `/api/models/cpp/download/<name>` | whisper.cpp 모델 다운로드 (SSE) |
| DELETE | `/api/models/cpp/delete/<name>` | whisper.cpp 모델 삭제 |
| POST | `/api/transcribe` | 음성 파일 변환 (SSE 실시간 스트리밍) |
| GET | `/api/debug-log` | 디버그 로그 파일 내용 반환 |

### 모델 경로
- **faster-whisper**: `~/.cache/huggingface/hub/models--Systran--faster-whisper-<name>`
- **whisper.cpp**: `C:\whisper-models\ggml-<name>.bin`
- **whisper-cli.exe**: `C:\whisper-bin\whisper-cli.exe` (영문 경로 고정 — 한글 경로 문제 회피)

### GPU 감지
- `torch.cuda.is_available()` → CUDA면 `float16`, 아니면 CPU `int8`
- GPU 실패 시 CPU로 자동 폴백

---

## 프론트엔드 주요 로직 (`src/pages/Index.tsx`)

### 화자 타입
```typescript
type Speaker = "C" | "P" | "X" | "E";
// C: 상담사, P: 내담자(Patient), X: 제3자, E: 기타
```

### 상태 흐름
1. 파일 선택 → `onFileSelect()` → 새 변환 or 이어하기 선택 모달
2. `onFile()` → FormData POST `/api/transcribe` → SSE 스트리밍 수신
3. 변환 완료 → `rawText`에 전체 텍스트 저장
4. "화자 분리 시작" → `mode: "raw" → "split"`, `Line[]` 배열 생성
5. Enter 키 → 줄 분할 + 자동 화자 전환 (`handleSplitKey`)
6. 화자 칩 클릭 → `cycleSpeaker()` (C→P→X→E→C 순환)
7. 저장 → `exportDocx()` / `exportTxt()`

### 세션 저장 형식 (JSON)
```json
{ "version": 1, "fileName": "", "mode": "split", "rawText": "", "lines": [], "showTime": false }
```

### localStorage 키
- `gb_user`: 사용자 이름
- `gb_model`: 선택 모델 (`small` / `medium` / `large-v3`)
- `gb_engine`: 선택 엔진 (`python` / `cpp`)
- `gb_autosave_raw`: 자동저장 원문
- `gb_convert_progress`: 변환 중단 시 이어하기 데이터 (JSON)

### 단축키
| 키 | 동작 |
|----|------|
| Space / Esc | 재생/정지 |
| Shift+Space | 편집 중에도 재생/정지 |
| ← / → | 3초 이동 |
| Shift+←/→ | 편집 중에도 3초 이동 |
| Enter (화자 분리 모드) | 줄 분할 + 화자 전환 |

---

## 가계도 에디터 (`src/pages/Genogram.tsx`)

### 노드 타입 (Gender)
`남성` / `여성` / `논바이너리` / `레즈비언` / `게이` / `임신` / `사산아` / `자연유산` / `인공유산`

### 관계선 타입 (LineType)
- 가족관계: `결혼` / `별거` / `이혼` / `재결합` / `동거`
- 감정관계: `소원` / `친밀` / `밀착` / `단절`
- 갈등: `갈등` / `융합된갈등`
- 학대: `신체적학대` / `성적학대`

---

## 빌드 및 실행

```bash
# 개발 모드
npm run electron:dev    # Vite dev + Electron 동시 실행

# 프로덕션 빌드
npm run dist            # Vite build → electron-builder → release/

# 백엔드만 단독 실행
cd server
python app.py           # http://127.0.0.1:5577
```

### electron-builder 설정 요약
- appId: `com.aninsong.gongulbaki`
- 대상: Windows NSIS 인스톨러
- extraResources: `resources/server` → 패키지의 `resources/server/`
- 패키징된 Python 서버: `resources/server/app.exe` (PyInstaller frozen)

---

## 디버그 로그
- 경로: `~/gongulbaki_debug.txt` (홈 디렉터리)
- 7일 이상 된 로그 자동 삭제
- 앱 시작 시 OS, Python 버전, RAM, CPU 코어 수 기록
