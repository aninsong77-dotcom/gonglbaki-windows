# 티켓③ — 참고자료 RAG

> 선행: ② 완료(프롬프트 주입 접합부만 대기) · 파싱/임베딩 파이프라인 자체는 ①만 있으면 착수 가능(병렬)
> 후행: ④(축어록+참고자료 동시 활용)

---

## 1. AS-IS (Read로 확인)

- `server/requirements.txt`: PDF 파싱 라이브러리 없음. `numpy`는 이미 있음(벡터 연산 재사용 가능, 신규 의존성 아님).
- `server/app.py` 1640~1659행 `_hwpx_extract_preview`: zipfile+ElementTree로 hwpx 문단/표를 순서대로 추출하는 **이미 검증된 자체 파서**. 서식 보존은 안 하지만(구현 목적이 미리보기라 원래 그럼), RAG는 텍스트 검색용이라 이 정도로 충분(requirements.md §7 제외 범위와 일치). **단, 실제 반환 타입을 코드로 확인한 결과(1644·1654·1658행) 이 함수는 순수 텍스트 문자열이 아니라 `blocks`(`{"type":"text","text":...}` 또는 `{"type":"table","rows":[[...]]}` 형태의 딕셔너리 리스트)를 반환한다** — RAG 조각화(청킹)를 하려면 이 blocks를 하나의 이어진 텍스트로 합치는 변환 단계가 별도로 필요하다(표는 행을 `" | "`로 이어붙이는 식). 함수 자체를 수정하지 말고(미리보기 기능 회귀 방지), `reference_store.py`에 "blocks → flat text" 변환 함수를 새로 추가해 감싸 쓴다.
- `~/.claude/skills/hwpx/scripts/hwpx2md.py`: 존재 확인함(4223바이트) — 그러나 이 경로는 **Claude Code를 쓰는 이 컴퓨터의 스킬 디렉토리**이지 곤글박이 앱의 실행 환경이 아니다. 곤글박이는 최종 사용자(다른 상담사·수련생) PC에 인스톨러로 배포되는 앱이므로 이 경로를 런타임에 참조할 수 없다 — **이식하려면 해당 스크립트의 로직을 `server/` 안으로 파일 복사·재작성해야 하는데, 위 이유로 아예 이식하지 않고 §1의 자체 파서를 재사용하는 것이 맞다.**
- `preload.cjs` 33행/`electron-main.cjs` 246~253행 `case-select-file`: **이름은 "case"이지만 실제로는 범용 파일 선택 다이얼로그**(필터만 인자로 받음, 사례 관련 로직 없음) — 참고자료 파일 선택에 **그대로 재사용 가능, 신규 IPC 불필요**. 단, `properties: ["openFile"]`(251행 근처)이라 다중 선택은 안 됨 — 여러 파일을 한 번에 등록하려면 `multiSelections` 옵션 추가가 필요(§2.3에서 결정).
- `_llama_server` 상태 dict(701행 `{"proc": None, "port": None}`)는 **요약 LLM 전용 단일 슬롯**이다. 임베딩 모델(bge-m3 계열)은 요약 모델과 **다른 gguf 파일**이므로, 같은 llama-server 인스턴스를 공유할 수 없다(llama-server 1개 프로세스 = gguf 1개 로드) — **임베딩용 llama-server를 별도 포트로 기동하는 두 번째 상태 관리 슬롯이 필요**(구조는 `_ensure_llama_server`와 동일 패턴 복제, 병합은 아님).

## 2. TO-BE

### 2.1 신규 모듈 (백엔드)

| 경로 | 역할 |
|---|---|
| `server/reference_store.py` | 참고자료 CRUD, 조각화, 벡터 저장/로드, 코사인 유사도 검색 — `app.py`에 전부 넣기엔 이미 1990행이라 신규 모듈로 분리(단일 책임 원칙, `_hwpx_extract_preview`는 `app.py`에서 import해 재사용) |
| `server/pdf_extract.py` (선택 — 함수 1개면 `reference_store.py`에 합쳐도 됨) | PDF 텍스트 추출 래퍼 |

### 2.2 PDF 파싱 라이브러리 선정 (효율 우선순위 — 결정 필요 사항)

현재 Python 의존성엔 PDF 라이브러리가 전혀 없다. 후보:

| 후보 | 특징 |
|---|---|
| `pypdf` | 순수 Python, 컴파일 불필요(PyInstaller 번들 시 안전), MIT 라이선스, 텍스트 추출만 필요한 이 요구사항에 충분 |
| `pdfplumber` | 표 추출 강점이 있지만 내부적으로 `pdfminer.six` 의존 — 이 요구사항(표 보존 불필요)엔 과함 |
| `PyMuPDF`(fitz) | 빠르지만 AGPL/상용 라이선스 조건 — 배포 앱에 라이선스 검토 부담 |

**권고**: `pypdf` — requirements.md가 "표/레이아웃 보존 불필요, 텍스트 검색용"이라 명시했고, 순수 Python이라 PyInstaller 패키징(`server/app.spec`) 리스크가 가장 적다. *(참고: 이 선택은 Claude가 연구 논문을 직접 파싱할 때 강제되는 `parse_pdf` MCP 규칙과는 무관한, 이 앱 자체의 런타임 의존성 결정이다 — 그 규칙은 Claude의 논문 인용 파싱 행동에 관한 것이고, 여기서는 곤글박이 서버가 상담학 강의자료에서 텍스트를 추출하는 소프트웨어 기능이다.)*

`server/requirements.txt`에 `pypdf` 한 줄 추가.

### 2.3 참고자료 파일 선택 — 신규 IPC 불필요 확인

`caseDrawerAPI.selectFile(filters)`를 그대로 호출(`preload.cjs`/`electron-main.cjs` 변경 없음)해 파일 절대 경로만 얻는다. **파일 내용을 렌더러가 읽어서 서버로 전송하지 않는다** — 절대경로 문자열만 `/api/reference/add`에 POST하고, Flask 서버가 그 경로를 직접 열어 파싱한다(대용량 PDF를 base64로 IPC 왕복시키는 비효율 회피, Flask 서버는 로컬 파일시스템 전체 접근 권한이 이미 있음 — `get_llm_model_path()`가 `C:\whisper-models`를 직접 여는 것과 동일 원칙).

다중 파일 등록을 한 번에 지원하려면 `case-select-file` 핸들러에 `multiSelections` 옵션이 필요 — 이는 기존 사례서랍 파일 선택(단일 파일 첨부 용도)에 영향 주지 않도록 **새 파라미터를 옵션으로 추가**(예: `selectFile(filters, { multiple: true })`, 호출부에서 안 넘기면 기존 동작 그대로) — `preload.cjs`/`electron-main.cjs`에 대한 유일한 실질 변경.

### 2.3.1 참고자료 원본 복사 여부

`ReferenceDoc.sourcePath`(structure.md 4.3) — "참고자료 창고 폴더 내부 복사본 또는 원본 참조"가 미확정이었다. **복사본으로 확정 권고**: 사례서랍의 "경로로만 연결(복사 X)" 원칙(`CaseDrawer.tsx` 17~22행 주석)은 "이미 존재하는 사례 폴더 체계를 건드리지 않기 위함"이 이유인데, 참고자료 창고는 애초에 신규 전용 폴더(사례와 무관)이므로 원본이 사용자 PC 다른 곳으로 이동·삭제되어도 검색이 깨지지 않도록 **원본을 창고 폴더로 복사**하는 편이 안전(안전 우선순위)하다. 복사 비용(강의자료 수십 MB급)은 무시 가능한 수준.

### 2.4 임베딩 서버 (신규 상태 슬롯)

```python
# server/app.py 또는 reference_store.py — _llama_server 패턴을 복제(공유 아님, 별도 슬롯)
_embed_server = {"proc": None, "port": None}
EMBED_MODEL_FILE = "bge-m3-Q4_K_M.gguf"  # 실제 파일명은 개발 단계에서 확정
EMBED_MODEL_URL = ".../releases/download/models/" + EMBED_MODEL_FILE

def _ensure_embed_server() -> bool:
    # _ensure_llama_server()와 동일 구조, --embedding 플래그 추가, 별도 포트
    ...
```

**리스크**: 요약용 llama-server와 임베딩용 llama-server가 **동시에 상주**하면 메모리 사용량이 두 배로 늘어난다(2.1B~4B급 + bge-m3, 각각 GGUF 전체를 RAM에 올림). 저사양 PC(요구사항 문서에 명시된 상담학 학생·수련생 대상 — 고사양 워크스테이션 가정 어려움)에서 문제가 될 수 있음(Warning 대응):

- **판정 기준(수치로 확정)**: 개발 PC 기준 "요약 모델(Qwen3-4B, ①에서 실측된 상주 메모리) + 임베딩 모델(bge-m3, 통상 Q4_K_M 기준 300~600MB급) 동시 상주" 시 총 RAM 점유가 **8GB를 넘으면 상시 동시 상주 금지**로 판단 기준을 못박는다(상담학 학생 대상 노트북의 통상 실장 RAM 8~16GB 가정). 8GB 초과 시 §2.4의 "검색 시에만 기동, 끝나면 즉시 종료" 전략으로 강제 전환.
- **포트 할당**: 임베딩 서버도 요약 서버와 동일하게 `_pick_free_port()`(703~709행, 이미 있는 함수)를 그대로 재사용해 동적 포트를 받는다 — 고정 포트를 임베딩 서버에 새로 할당하지 않는다(2026-07-09 고정 포트 충돌 실사고 재발 방지 원칙을 그대로 계승, `_embed_server["port"]`에 저장).

### 2.4.1 임베딩 모델 출처 검증 (안전·보안 — ①과 동일 원칙 적용)

01-qwen-engine.md §3에서 확정한 **"배포 모델 = 공식 원본 직접 변환·양자화만, 제3자 변환본 금지"** 원칙은 요약 모델(Qwen3-4B)에만 적용되는 것이 아니라 **이 앱이 배포하는 모든 gguf 모델에 동일하게 적용되는 보안 기준**이다. 임베딩 모델(bge-m3 계열)도 예외가 아니다.

```
[임베딩 모델 준비 작업 순서 — ①의 §3과 동일 절차]
1. 채택할 bge-m3 계열 gguf의 배포 출처 확인 — 공식(BAAI bge-m3 HuggingFace 원본을 직접 GGUF 변환한 것)인지,
   제3자 재배포 gguf(예: 커뮤니티 quantization 저장소)인지 먼저 확인한다.
2. 공식 원본 직접 변환본이 아니면, ①과 동일하게 공식 HuggingFace 원본을 받아
   llama.cpp convert_hf_to_gguf.py(임베딩 모델 지원 여부 사전 확인 필요 — 임베딩 전용 아키텍처는
   변환 스크립트 지원 범위가 요약 모델과 다를 수 있음) → 번들 llama-quantize.exe로 양자화 → 대조 검증.
3. GitHub 릴리스(gonglbaki-windows, models 태그)에 업로드, 2GB 제한 확인(bge-m3는 통상 1GB 미만이라
   Qwen3-4B보다 이 문제는 여유 있음 — 실측 후 확정).
4. EMBED_MODEL_URL 갱신 + 실제 다운로드 검증.
```

**리스크**: 임베딩 모델은 요약 모델보다 상대적으로 "덜 중요해 보여서" 출처 검증을 건너뛰기 쉽다 — 하지만 검색 정확도·환각 방지(§8 테스트 필수 대상 "RAG 근거 정확성")에 직결되는 핵심 구성요소이므로 검증 없이 넘어가면 안 된다. 완료 조건에 명시 항목 추가(§4).

### 2.5 조각화·저장 스키마

```python
# reference-library/vectors.json (구조체, structure.md 4.3과 동일)
[{"chunkId": str, "refId": str, "fileName": str, "text": str}]
# reference-library/vectors.npy — 위 리스트와 같은 순서의 (N, dim) float32 배열
```

조각화 규칙: `ANALYZE_CHUNK_CHARS = 3000`(622행, 기존 요약 조각 크기 상수)을 그대로 재사용할지, 임베딩 모델 컨텍스트 한도에 맞춘 별도 상수(`REFERENCE_CHUNK_CHARS`)를 둘지는 개발 단계에서 임베딩 모델 실측 토큰 한도 확인 후 결정(강의자료는 상담 축어록과 문장 밀도가 다를 수 있어 상수를 분리하는 쪽을 권고).

### 2.6 검색 → 프롬프트 주입 (② 접합부)

```
POST /api/chat/send 내부 흐름:
1. 참고자료 창고에 벡터가 1개 이상 있으면(reference_store.has_vectors())
   질문 텍스트를 임베딩 → 코사인 유사도 상위 N개(N=3~5, 개발 중 확정) 조각 선택
2. 없으면 이 단계 전체 스킵(§요구사항 "없을 때 RAG 없이 일반 대화로 폴백")
3. 선택된 조각을 시스템/유저 메시지 프롬프트에 "[참고자료: {fileName}] {text}" 형태로 주입
4. 응답 메시지의 sources 필드에 {fileName, snippet} 채움(ChatMessage.sources, structure.md 4.2)
```

이 지점은 ②가 만든 `/api/chat/send` 함수 안의 정확한 훅 위치(② 완료 문서에 주석으로 남김)에만 삽입 — 함수 전체 재작성 아님.

### 2.7 신규 엔드포인트

```
GET    /api/reference/list
POST   /api/reference/add        { path: string }  (SSE 진행률 — 큰 PDF 파싱·임베딩 시간 고려)
DELETE /api/reference/{id}
GET    /api/embed/status
GET    /api/embed/model/download (SSE, 기존 analyze_model_download 패턴 재사용)
```

`DELETE /api/reference/{id}`: id→경로 매핑은 서버가 관리하는 인덱스(참고자료 목록 JSON)에서만 조회하고, 요청 바디의 경로 문자열을 직접 삭제에 쓰지 않는다(보안 위험 대응, §00 overview).

## 3. 다른 티켓과의 연결

- TICKET-①에서 받는 것: 없음(독립적 파이프라인, 단 `_ensure_llama_server` 패턴을 복제 참고).
- TICKET-②에서 받는 것/②에 주는 것: `/api/chat/send` 내부 훅 지점(§2.6) — ②가 먼저 정의한 함수에 ③이 검색 로직을 삽입.
- TICKET-④에 주는 것: 축어록 컨텍스트와 참고자료 컨텍스트를 "같은 채팅 창에서 동시 참조"하는 요구사항(④) — ③이 만든 검색 함수를 ④가 그대로 재호출(sessionId 유무와 무관하게 동일 검색 로직).
- 공유 파일 주의: `server/app.py`에 신규 import(`from reference_store import ...`)만 추가, 기존 함수 수정 없음(②가 만든 `/api/chat/send` 내부 1개 지점 제외).

## 4. 완료 조건

```
[ ] pypdf server/requirements.txt 추가(권고안 확정 또는 대안 사유 기록)
[ ] server/reference_store.py 신규 모듈 — hwpx는 app.py의 _hwpx_extract_preview 재사용(신규 이식 없음) 확인
[ ] 참고자료 등록/목록/삭제 UI(전역 자료 창고) — caseDrawerAPI.selectFile 재사용, 신규 IPC는 multiSelections 옵션 1건만
[ ] 참고자료 원본이 창고 폴더에 복사됨(원본 파일 이동/삭제에도 검색 안 깨짐) 확인
[ ] PDF/hwpx/txt/md 4종 파싱 → 조각화 확인, 손상 파일은 개별 에러 처리(전체 등록 흐름 안 죽음)
[ ] 임베딩 모델 출처 검증 완료(공식 원본 직접 변환 확인, §2.4.1) — 제3자 변환본 그대로 배포 금지, ①과 동일 기준
[ ] 임베딩 서버 별도 슬롯(_embed_server)으로 기동, _pick_free_port()로 동적 포트 할당(고정 포트 금지), 요약 서버와 독립적으로 관리됨
[ ] 요약+임베딩 서버 동시 로드 시 메모리 사용량 실측 — 8GB 초과 시 "검색 시에만 기동" 방식으로 전환(§2.4 판정 기준)
[ ] _hwpx_extract_preview()가 반환하는 blocks(문단/표 배열)를 하나의 검색용 텍스트로 합치는 변환 함수(reference_store 내) 별도 구현 확인 — 이 함수는 현재 "미리보기 화면 표시용" 구조체를 반환하지, 청킹 가능한 순수 텍스트를 반환하지 않는다(§1 AS-IS 재확인 필요)
[ ] numpy+JSON 벡터 저장/로드 확인(FAISS/Chroma 등 외부 라이브러리 미도입 확인)
[ ] 질의 → 유사 조각 검색 → 프롬프트 주입 → 응답 반영, sources(파일명) 표시
[ ] 참고자료 0건일 때 RAG 없이 일반 대화 정상 폴백
[ ] DELETE 엔드포인트가 서버 관리 인덱스로만 경로 조회(요청 경로 문자열 직접 삭제 금지) 확인
[ ] 신규 라우트 전부 127.0.0.1 바인딩·기존 CORS 설정 무변경 확인
```
