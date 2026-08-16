# 티켓② — 대화형 채팅 UI

> 선행: ① 완료 · 후행: ③(접합부만 대기), ④

---

## 1. AS-IS (Read로 확인)

`src/pages/Index.tsx`:
- 823~845행: 분석 패널 상태 전부(`analyzeOpen`/`analyzeBusy`/`analyzeMsg`/`analyzeWords`/`analyzeSummary`/`analyzeLabeled`/`analyzeScope`/`analyzeModelReady`/`analyzeDownloading`/`analyzeDlMb`/`analyzeFresh`/`analyzeChunks`) — **전부 "단발 요약" 모델**. 멀티턴 대화 개념이 없음.
- 839~840행: `analyzePartialsRef`/`analyzeScopeCacheRef` — 조각 요약을 ref로 들고 있다가 scope 전환 시 재사용하는 캐시. 이 캐시 패턴 자체(재계산 없이 로컬에 들고 있다가 전환)는 새 채팅 UI에서도 "대화 목록 전환 시 이미 로드한 대화를 다시 fetch 안 함" 용도로 재사용 가능한 아이디어.
- 877~992행: `checkAnalyzeStatus`/`downloadAnalyzeModel`/`runAnalysis`/`switchAnalyzeScope`/`stopAnalysis` — `runAnalysis`(912~970행 추정)가 `/api/analyze/words` fetch 후 `/api/analyze/summarize` SSE를 열고 버퍼링(`buf.split("\n\n")`) 파싱하는 패턴 — **이 SSE 파싱 로직(라인 304~316 `SummaryModelSettings.download`에도 동일 패턴 중복 존재)을 신규 `/api/chat/send` 소비에도 그대로 재사용**.
- 2573~2777행: 분석 패널 JSX 전체(말풍선 개념 없음, 단일 텍스트 블록 + scope 토글 + 조각별 아코디언).
- 2842행: `<CaseDrawer />` — Index.tsx 최상위에서 형제로 렌더링, 현재 props 없음.

`server/app.py`:
- 929~990행 `analyze_summarize`: SSE 이벤트 스키마 `{"type": "progress"|"chunk"|"cancelled"|"done", ...}` — 신규 `/api/chat/send`가 계승할 이벤트 네이밍 규칙의 실제 소스.
- 1017~1027행 `analyze_stop`: `_analyze_state["cancelled"]=True` + `_stop_llama_server()` — **주의**: 이 함수는 상주 llama-server 프로세스 자체를 죽인다(전역 자원). 채팅 스트리밍과 요약 스트리밍이 같은 llama-server를 공유하므로, 티켓②에서 "새 대화 시작" 버튼이 실수로 이 stop 경로를 타면 **다른 탭에서 진행 중이던 요약까지 함께 끊긴다**(§00 overview 안정성 위험 항목).

## 2. TO-BE

### 2.1 신규 파일 (프론트)

| 경로 | 역할 |
|---|---|
| `src/pages/chat/AnalyzeChatPanel.tsx` | 기존 2573~2777행 JSX를 대체하는 최상위 채팅 패널. `Index.tsx`가 `activeTab === "transcribe"`일 때 렌더 |
| `src/pages/chat/useChatSession.ts` | 신규 상태 훅 — `conversationId`, `messages: ChatMessage[]`, `streaming`, SSE 연결·재연결, 히스토리 로드/저장 호출을 캡슐화(823~845행 상태군을 대체) |
| `src/pages/chat/MessageBubble.tsx` | 사용자/AI 말풍선, 스트리밍 중 토큰 이어붙임 표시 |
| `src/pages/chat/MarkdownLite.tsx` | 마크다운 렌더러(§2.5에서 자체구현/라이브러리 결정) |
| `src/pages/chat/ChatHistoryList.tsx` | 저장된 대화 목록(제목/최근시각), `/api/chat/list` 소비 |
| `src/pages/chat/QuickActions.tsx` | 기존 "전체/내담자만/상담자만" 요약 버튼 + "빈출 단어 보기" 버튼 — `_analyze_ask_llm` 계열 호출은 채팅 흐름 안 첫 메시지로 변환, Kiwi 빈출 단어는 기존 `/api/analyze/words` 그대로 별도 표시(AI 아님, requirements.md 확정 사항) |

기존 `analyzeOpen`/`analyzeBusy` 등 11개 state(823~845행)는 **삭제**하고 `useChatSession` 훅으로 대체(00-overview.md의 structure.md 인용대로 "그대로 확장하지 않음" 원칙).

### 2.2 신규 엔드포인트 (`server/app.py`, ①이 끝난 596~1032행 구간 뒤에 이어 추가)

```
POST /api/chat/new     { caseDir?: string, linkedSessionId?: string } → { conversation_id }
GET  /api/chat/list     ?caseDir=&linkedSessionId=(선택) → [{id, title, updatedAt, linkedSessionId}]
GET  /api/chat/<id>     → { id, title, messages: ChatMessage[] }
DELETE /api/chat/<id>
POST /api/chat/send (SSE)  { conversation_id, message } → type: token|done|error|cancelled
POST /api/chat/stop     { conversation_id }
```

**중요 설계 결정 — 저장 위치 분기의 실제 구현 방법**: structure.md §5는 "사례 폴더 안 또는 전역 위치"라고만 정해뒀는데, Flask 서버 프로세스는 CaseDrawer가 관리하는 `rootFolder`(Electron 쪽 `caseDrawerAPI.getSettings()`가 아는 값)를 알 방법이 없다. 즉 **`conversation_id`만으로는 사례 폴더 경로를 알 수 없다** — 프론트가 `/api/chat/new` 호출 시 `caseDir`(절대경로 문자열, CaseDrawer에서 얻은 값)를 명시적으로 함께 넘겨야 한다. 넘기지 않으면 전역 위치(`Path.home() / "gongulbaki_chats"`, 기존 `DEBUG_LOG_PATH = Path.home() / "gongulbaki_debug.txt"` 패턴과 동일한 방식)에 저장.

```python
# server/app.py 신규 상수 — 기존 DEBUG_LOG_PATH 패턴 재사용
CHAT_STORE_DIR = Path.home() / "gongulbaki_chats"   # caseDir 미지정 시 전역 저장 위치
```

- 사례 연결 대화: `<caseDir>/chats/<conversation_id>.json`
- 전역 대화: `C:\Users\<user>\gongulbaki_chats\<conversation_id>.json` (또는 `Path.home()` 하위, Windows에서 `~`)

각 대화 파일은 매 메시지 완료 시(스트리밍 `done` 이벤트 시점) 즉시 append 저장 — 전체 히스토리 매번 덮어쓰기 방식이 아니라, "앱 강제 종료 시 마지막까지 저장된 대화가 유실되지 않는다"는 요구사항(§8 테스트 필수 대상)을 만족시키기 위함.

멀티턴 컨텍스트는 서버가 해당 `conversation_id` 파일에서 직근 N턴(토큰 예산 내에서)을 읽어 `_analyze_ask_llm`과 동일한 Qwen ChatML 템플릿으로 이어붙인다 — system 메시지 1개 + user/assistant 턴 반복 구조로 확장(①에서 만든 단일 turn 템플릿의 자연스러운 확장, 신규 템플릿 설계 아님). **단, 컨텍스트 예산을 초과할 때의 처리는 "그냥 다 넣어본다"가 아니라 §2.3에서 확정한 규칙을 반드시 따른다 — 2026-07-09 컨텍스트 초과로 요약 결과가 빈 채 반환된 실사고(server/app.py 735~737행 주석, `_reduce_partials`)가 채팅에서는 히스토리 누적 때문에 훨씬 쉽게 재현될 수 있다.**

### 2.3 컨텍스트(대화 길이) 예산 관리 — 필수 설계 (안정성, Critical)

**왜 필요한가**: 회기 요약은 조각 단위로 끝나는 1회성 파이프라인이라 컨텍스트 초과가 "그 요약 1건"의 문제로 끝났다. 반면 채팅은 대화가 길어질수록 히스토리가 계속 쌓이고(②), 여기에 축어록 전체(④)와 참고자료 조각(③)까지 매 턴마다 함께 주입되므로 **같은 대화 안에서 몇 턴만 지나도 반복적으로 컨텍스트를 초과할 위험이 훨씬 크다** — 1회성 사고가 아니라 상시 위험.

**예산 산정**: `-c 16384`(①에서 Qwen 기준 재검증된 값, §01 참조) 중 응답 생성 여유(`max_tokens`, 기존 요약은 500~800) + system 지시문(약 300~500토큰 추정)을 미리 빼고, **나머지를 "동적 콘텐츠 예산"으로 고정 배정**한다. 글자→토큰 환산 비율은 ①에서 Qwen 토크나이저로 실측한 값을 그대로 가져다 쓴다(Kanana 실측 0.56토큰/자를 임시 추정치로 두되, ①ticket 완료 시 확정치로 교체 — 이 문서의 수치는 개발 착수 시 반드시 재확인).

**초과 시 처리 우선순위(고정 순서 — 임의 판단 금지)**:

```
0순위(항상 보존, 절대 자르지 않음): 시스템 지시문 + 이번 턴의 사용자 메시지
1순위(먼저 줄임): 참고자료(RAG) 조각 — top-N(기본 5개)에서 유사도 낮은 순으로 하나씩 제거,
                  N=0(참고자료 없이 응답)까지 줄여도 예산 내로 안 들어오면 다음 순위로
2순위: 축어록 컨텍스트(④, linkedSessionId 있을 때) — 원문 그대로 넣지 않고, 축어록 길이가
       예산을 위협하는 수준이면 ①의 map-reduce 요약 파이프라인(_analyze_ask_llm 기반)을
       재사용해 "이 회기 요약본"으로 1회 압축한 뒤 그 압축본을 주입한다(원문 자르기 금지 —
       중간에서 자르면 문맥이 끊겨 의미가 왜곡될 위험이 원문 요약보다 크다). 압축본은
       같은 conversation_id 안에서 재사용(매 턴 재요약 안 함 — 첫 참조 시 1회 계산 후 캐시).
3순위(마지막까지 남겨둠): 대화 히스토리 — 슬라이딩 윈도우로 "최근 K턴(기본 K=6, user+assistant
       합산)"은 원문 그대로 유지, 그보다 오래된 턴은 개별 보존하지 않고 하나의
       "이전 대화 압축 요약"(rolling summary) 문자열로 유지한다. 윈도우 밖으로 밀려나는
       턴이 생길 때마다 그 턴만 기존 rolling summary에 이어붙여 1회 재압축
       (_reduce_partials와 동일한 "묶음별 종합" 아이디어 재사용) — 대화가 아무리 길어져도
       히스토리가 보내는 프롬프트 크기는 K턴 + 압축 요약 1개로 상한이 고정된다.
```

즉 순서는 "참고자료 먼저 줄이고 → 축어록은 자르지 말고 요약으로 압축하고 → 히스토리는 최근 K턴만 원문 유지 + 나머지는 굴려가며 압축"이다. 이 세 단계를 거치고도 예산을 초과하는 경우(이론상 거의 없어야 함)는 사용자에게 "이번 질문은 참고 내용이 많아 일부만 반영했다"는 안내 문구를 응답에 덧붙인다 — 조용히 잘라서 품질이 나빠지는 것보다 사용자가 알 수 있게 한다(과거 "컨텍스트 초과를 코드가 삼켜서 빈 결과"가 나온 실사고의 교훈 — 에러를 침묵시키지 않는다).

### 2.4 "새 대화" vs "중지" 분리 (안정성 위험 대응)

`analyze_stop`(1017~1027행)이 `_stop_llama_server()`로 **상주 서버 프로세스 자체**를 죽이는 전역 동작이라는 점을 그대로 물려받으면 안 된다. `/api/chat/stop`은 **해당 `conversation_id`의 생성만** 취소하는 방식으로 새로 설계(전역 `_analyze_state["cancelled"]` 단일 플래그가 아니라 `conversation_id`별 취소 플래그 dict로 확장) — "새 대화 시작" 버튼은 이 stop 엔드포인트를 호출하지 않고 프론트 상태만 전환한다.

### 2.5 마크다운 렌더링 — 결정 필요 사항 (효율 우선순위)

`package.json`에 마크다운 렌더러가 없음(§00 overview §1-7 확인). requirements.md 범위가 "목록·강조·코드블록" 정도로 제한적(전체 GFM·표·각주 불필요)이므로 두 안을 비교:

| 안 | 장점 | 단점 |
|---|---|---|
| A. `react-markdown`(+선택 `remark-gfm`) 신규 의존성 | 검증된 파서, 엣지케이스 적음 | 번들 크기 증가, PyInstaller와 무관하지만 Vite 빌드 크기·의존성 관리 부담 추가 |
| B. 자체 경량 렌더러(`MarkdownLite.tsx`, 정규식 기반 — 줄바꿈/굵게/목록/코드블록만 처리) | 의존성 0, 필요한 만큼만 구현 | 엣지케이스(중첩 목록 등) 직접 처리해야 함 |

**권고**: 요구사항 범위가 좁고(목록·강조·코드블록) 사용자가 효율(불필요 의존성 최소화)을 명시적 우선순위로 지정했으므로 **B안(자체 경량 렌더러)으로 시작**, 실제 AI 응답에서 자체 렌더러로 못 다루는 패턴이 반복되면 그때 A안으로 전환 — 완료 조건에 이 결정을 명시적으로 기록.

### 2.6 화면 상태

requirements.md §5 표 그대로 구현: 빈 대화 / 전송 중 / 스트리밍 중(중지 버튼) / 정상 완료 / 에러 / 모델 미준비. RAG 검색 중 상태는 티켓③에서 "스트리밍 중"에 흡수(별도 상태 불필요 — 검색은 스트리밍 시작 전 내부 단계이므로 "전송 중" 상태 문구만 "참고자료 검색 중..."으로 세분화하면 충분, 신규 화면 상태 추가 없음).

## 3. 다른 티켓과의 연결

- TICKET-①에서 받는 것: Qwen ChatML 프롬프트 조립 규칙, 모델 상주 서버(`_ensure_llama_server`).
- TICKET-③에 주는 것: `/api/chat/send` 내부에 "참고자료 검색 결과를 프롬프트에 주입하는 지점" — 이 지점의 정확한 위치(메시지 조립 함수 어디에 훅을 거는지)를 코드 주석으로 명시해 티켓③이 그 지점만 확장하도록 한다.
- TICKET-④에 주는 것: `Conversation` 데이터 모델(`linkedSessionId` 필드), `/api/chat/new`의 `caseDir`/`linkedSessionId` 파라미터 — CaseDrawer가 이 계약대로 호출.
- 공유 파일 주의: `server/app.py`에 ①이 만든 596~1032행 구간 **아래**에 신규 라우트를 추가(기존 함수 시그니처·이벤트 스키마 변경 금지 — `analyze_summarize`/`analyze_reduce`는 요구사항대로 프론트 호환 유지).

## 4. 완료 조건

```
[ ] 823~845행 기존 analyze 상태 제거, useChatSession 훅으로 교체
[ ] 2573~2777행 JSX를 AnalyzeChatPanel로 교체(말풍선/입력창/스크롤/전 화면 상태 정의)
[ ] /api/chat/* 5개 엔드포인트 구현, SSE 이벤트 스키마 기존 analyze_summarize와 동일 네이밍
[ ] "새 대화 시작"이 _stop_llama_server()를 타지 않음(전역 서버 죽이지 않고 프론트 상태만 전환) 확인
[ ] conversation_id별 취소 플래그로 stop 구현(요약 스트리밍과 상호 간섭 없음)
[ ] 대화 저장 위치 분기(caseDir 유무) 동작 확인, 매 메시지 완료 시 즉시 append 저장
[ ] 앱 강제 종료 시뮬레이션 — 마지막 완료 메시지까지 유실 없음
[ ] 마크다운 렌더링 방식(A/B안) 결정 기록 + 목록·강조·코드블록 렌더 확인
[ ] 기존 "요약"(전체/내담자만/상담자만)·"빈출 단어" 기능이 QuickActions 버튼으로 채팅 흐름 안에서 회귀 없이 동작
[ ] 세션 내 멀티턴 컨텍스트 유지(이전 대화 참조 질문에 정상 응답)
[ ] 컨텍스트 예산 관리(§2.3) 구현 — 참고자료→축어록(요약 압축)→히스토리(슬라이딩 윈도우+rolling summary) 우선순위대로 축소되는지 확인
[ ] 컨텍스트 초과 시나리오 강제 재현(참고자료 다량 + 긴 축어록 + 장기 대화 동시) — 에러/빈 응답 대신 축소된 형태로라도 정상 응답, 필요 시 "일부만 반영했다" 안내 문구 표시 확인(과거 "빈 결과" 실사고 재발 방지, ①의 조각 20개 실사용 검증과 동일한 취지)
```
