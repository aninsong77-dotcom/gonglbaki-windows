# 분석페이지 대화형 AI — 구조 설계

> 작성일: 2026-07-20 · 작성: planner
> `requirements.md`의 4개 티켓(①Qwen 통합 ②대화형 UI ③RAG ④사례서랍 연동)에 대응하는 컴포넌트·API·데이터 모델 설계.
> 코드는 작성하지 않는다 — 이 문서는 impl-planner가 티켓·파일 단위로 쪼갤 때의 입력 스펙이다.

---

## 1. 영향 파일 개요

| 파일 | 티켓 | 변경 유형 |
|---|---|---|
| `server/app.py` | ①②③④ | 모델 교체, 신규 엔드포인트(대화·임베딩·검색·참고자료 CRUD) 추가 |
| `src/pages/Index.tsx` | ①②③ | 분석 패널 → 채팅 UI로 재설계, 참고자료 관리 화면 추가 |
| `src/pages/CaseDrawer.tsx` | ④ | 회기 선택 → 채팅 컨텍스트 연결, `SessionRecord.analysis` 저장 흐름 연결 |
| `preload.cjs` / `electron-main.cjs` | ③ | 참고자료 파일 선택 IPC 추가(기존 `case-select-file` 패턴 재사용) |
| `~/.claude/skills/hwpx/scripts/hwpx2md.py` | ③ | 참고자료 hwpx 파싱용으로 서버 쪽에서 이식/호출 |
| (신규) `server/rag/` 또는 `server/app.py` 내 함수군 | ③ | 임베딩·조각화·벡터 검색 로직 |
| (신규) 참고자료 창고 폴더, 대화 저장 폴더 | ②③ | 파일시스템 구조 신설(§5) |

---

## 2. 컴포넌트 구조 (프론트)

```
Index.tsx
 └─ AnalyzeChatPanel (신규, 기존 "분석" 패널 대체)
     ├─ ChatHeader
     │    ├─ 새 대화 버튼
     │    └─ 대화 목록 열기(과거 대화 전환)
     ├─ ChatHistoryList (신규, 사이드 또는 드롭다운 — 저장된 대화 목록)
     ├─ MessageList
     │    ├─ UserBubble
     │    └─ AssistantBubble (마크다운 렌더러 포함, 스트리밍 중 이어붙임)
     │         └─ SourceBadge (③ 이후 — 참고자료 출처 표시, 파일명 단위)
     ├─ QuickActions (기존 "요약"/"빈출 단어" 액션을 채팅 흐름 안 버튼으로 편입)
     │    ├─ [전체 요약] [내담자만] [상담자만] (기존 scope 토글 계승)
     │    └─ [빈출 단어 보기] (기존 Kiwi 집계, AI 아님 — 별도 표시 유지)
     ├─ ReferenceLibraryPanel (신규, ③ — 참고자료 창고: 목록/추가/삭제, 사례 무관 전역)
     ├─ ChatInput (텍스트 입력 + 전송 + 중지 버튼)
     └─ ModelReadyGate (기존 analyzeModelReady 패턴 계승 — 모델 미다운로드 시 다운로드 유도)

CaseDrawer.tsx (④)
 └─ 회차별 자료 영역 — "채팅으로 분석" 버튼(신규) → AnalyzeChatPanel을 해당 SessionRecord 컨텍스트로 오픈
```

- `AnalyzeChatPanel`은 기존 `Index.tsx` 내 분석 관련 상태(`analyzeOpen`, `analyzeBusy`, `analyzeSummary` 등 822~950행대)를 대체하는 새 상태 모델로 재작성한다(기존 상태를 그대로 확장하지 않음 — 채팅형 멀티턴 구조와 기존 단발 요약 상태 모델이 맞지 않기 때문). 기존 SSE 재개(이어하기)·화자 라벨 분기 로직은 함수 단위로 재사용.
- `ReferenceLibraryPanel`은 `Index.tsx`(전역 자료 창고이므로 특정 사례 화면이 아닌 분석 패널 상위 또는 설정 화면 인접 위치)에 둔다 — 정확한 배치는 impl-planner 단계에서 확정.

---

## 3. API 명세 (Flask, `server/app.py`)

### 3.1 티켓 ① — 기존 엔드포인트 유지, 내부 구현만 교체

| 엔드포인트 | 변경 |
|---|---|
| `GET /api/analyze/status` | `model_size_mb` 값을 Qwen3-4B 실제 용량으로 교체 |
| `GET /api/analyze/model/download` | `LLM_MODEL_URL`을 Qwen3-4B gguf 자산으로 교체, SSE 응답 포맷 동일 |
| `_analyze_ask_llm`, `_reduce_partials` (내부 함수) | 프롬프트 조립을 Qwen ChatML(`/no_think`)로 재작성 |
| `POST /api/analyze/summarize`, `POST /api/analyze/reduce` | 요청/응답 스키마 동일 유지(프론트 호환) |

### 3.2 티켓 ② — 신규 대화 엔드포인트

| 엔드포인트 | 메서드 | 요청 | 응답 |
|---|---|---|---|
| `/api/chat/send` | POST (SSE) | `{ conversation_id, message, context?: {sessionId, transcript} }` | SSE `type: token\|done\|error\|cancelled` — 기존 `analyze_summarize`의 SSE 이벤트 패턴 계승 |
| `/api/chat/stop` | POST | `{ conversation_id }` | 기존 `analyze_stop`과 동일 패턴(진행 중 생성 중단) |
| `/api/chat/list` | GET | `?sessionId=` (선택) | 저장된 대화 목록(제목/최근시각/연결된 회기) |
| `/api/chat/{conversation_id}` | GET | - | 해당 대화의 전체 메시지 히스토리 |
| `/api/chat/{conversation_id}` | DELETE | - | 대화 삭제(수동 삭제 원칙) |
| `/api/chat/new` | POST | `{ sessionId?: string }` | 새 `conversation_id` 발급 |

멀티턴 컨텍스트: 백엔드가 `conversation_id` 기준으로 지금까지의 메시지를 불러와 프롬프트에 포함(프론트가 매번 전체 히스토리를 보내지 않아도 되게 서버가 파일에서 읽음 — §5 저장 스키마).

### 3.3 티켓 ③ — 참고자료 CRUD + 검색

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/api/reference/list` | GET | 등록된 참고자료 목록(파일명·형식·등록일·조각 수) |
| `/api/reference/add` | POST | 파일 경로 등록 → 파싱·조각화·임베딩까지 동기 또는 SSE 진행률(파일 크기에 따라 시간 소요 예상 — SSE 권장) |
| `/api/reference/{id}` | DELETE | 원본 + 임베딩 삭제 |
| `/api/embed/status` | GET | 임베딩 모델(gguf) 준비 상태 — 기존 `analyze_status` 패턴 계승 |
| `/api/embed/model/download` | GET (SSE) | 임베딩 모델 다운로드 — 기존 `analyze_model_download` 패턴 재사용 |

`POST /api/chat/send`가 내부적으로 참고자료 벡터 검색(상위 N개)을 수행해 프롬프트에 컨텍스트로 주입한다(별도 "/api/reference/search" 엔드포인트를 프론트가 직접 부르지 않음 — 검색은 대화 파이프라인 내부 단계).

### 3.4 티켓 ④ — 사례 연동

기존 `/api/chat/send`의 `context.sessionId`를 CaseDrawer에서 채워 전달 — 신규 엔드포인트 없음. 요약 결과를 `SessionRecord.analysis`에 저장하는 것은 기존 `caseDrawerAPI.writeText` IPC(파일 쓰기)를 프론트에서 호출하는 방식으로, 서버 API 신설 불필요.

---

## 4. 데이터 모델 변경

### 4.1 `CaseRecord` / `SessionRecord` (`src/pages/CaseDrawer.tsx`)

변경 없음(④는 기존 `SessionRecord.analysis: FileRef` 슬롯을 그대로 재사용). 신규 필드가 필요해지면(예: 대화 ID를 세션에 연결) impl-planner 단계에서 아래 후보를 검토:

```ts
// 검토 후보 — 확정 아님, impl-planner에서 결정
type SessionRecord = {
  ...
  chatConversationIds?: string[];  // 이 회기에 연결된 대화 ID들(선택)
};
```

### 4.2 대화(Conversation) — 신규

```ts
type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sources?: { fileName: string; snippet: string }[]; // ③ RAG 근거 표시용
};

type Conversation = {
  id: string;
  title: string;            // 첫 메시지 요약 또는 사용자 지정
  createdAt: string;
  updatedAt: string;
  linkedSessionId?: string; // ④ — 특정 회기와 연결된 경우
  messages: ChatMessage[];
};
```

### 4.3 참고자료(Reference) — 신규

```ts
type ReferenceDoc = {
  id: string;
  fileName: string;
  format: "pdf" | "hwpx" | "txt" | "md";
  addedAt: string;
  sourcePath: string;       // 원본 파일 경로(참고자료 창고 폴더 내부 복사본 또는 원본 참조 — §5에서 확정)
  chunkCount: number;
};

// 벡터 저장 (numpy+JSON, 파일 형태 — TS 타입 아님, 참고용 스키마)
// reference_vectors.json: [{ chunkId, refId, text, embedding: number[] }]
```

---

## 5. 저장 위치 (파일시스템)

| 데이터 | 위치(기본안) | 비고 |
|---|---|---|
| 대화(Conversation) | `<사례폴더>/chats/<conversation_id>.json` (④로 세션 연결된 경우) 또는 앱 전역 `<설정루트>/chats/<conversation_id>.json` (세션 미연결 자유 대화) | 사례와 무관한 일반 대화가 존재할 수 있어(질문 자체가 채팅②는 ④ 이전에 완성) 전역 위치도 필요 — 정확한 분기 규칙은 impl-planner에서 확정 |
| 참고자료 원본 | `<설정루트>/reference-library/originals/` | 전역 공통 창고, 사례 무관(확정 사항) |
| 참고자료 임베딩 벡터 | `<설정루트>/reference-library/vectors.json` (numpy 배열은 `.npy`로 별도 저장, 매핑은 JSON) | numpy+JSON 자체 구현(확정 사항) |
| Qwen3-4B gguf | `C:\whisper-models\` (기존 `get_llm_model_path()` 패턴 유지) | 경로 불변, 파일명만 교체 |
| 임베딩 gguf 모델 | `C:\whisper-models\` (동일 디렉토리, 파일명 구분) | 기존 패턴 재사용 |

> `<설정루트>`는 기존 `caseDrawerAPI.getSettings()`가 반환하는 `rootFolder` 하위 또는 앱 데이터 폴더 — impl-planner 단계에서 기존 설정 구조 조사 후 확정.

---

## 6. 의존성 매핑 (티켓 간)

```
① Qwen 통합 (독립적으로 시작 가능)
    ↓
② 대화형 UI (①의 프롬프트 포맷 위에서 구현 — ①선행 필요)
    ↓
③ 참고자료 RAG (②의 채팅 파이프라인에 검색 컨텍스트를 주입하는 구조이므로 ②선행 필요.
    단, 참고자료 등록/파싱/임베딩 파이프라인 자체는 ②와 병렬 개발 가능 —
    "검색 결과를 프롬프트에 주입하는 지점"만 ②완료를 기다림)
    ↓
④ 사례서랍 연동 (②의 conversation 구조 + CaseDrawer 기존 구조 위에서 연결 — ②선행 필요,
    ③과는 독립적이나 "축어록+참고자료 동시 활용" 요구사항 때문에 ③이후 완료가 자연스러움)
```

병렬 가능 구간: ③의 파싱·임베딩·저장 파이프라인(백엔드)은 ②의 프론트 UI 작업과 동시에 진행 가능(백엔드/프론트 분리 작업).

---

## 7. 다음 단계

이 구조 설계와 `requirements.md`를 확인해 주시면, 4개 티켓(①~④)을 impl-planner로 넘겨 코드베이스 전수조사 기반 작업계획서(파일별 상세 변경점·스프린트 그룹핑)를 만들 것을 제안합니다.
