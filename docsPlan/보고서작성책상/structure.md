# 보고서 작성 책상 — 구조 설계

> requirements.md 의 결정을 코드 구조로 옮긴 문서. 실제 구현 전 impl-planner 단계에서 파일별 티켓으로 다시 쪼갠다.

---

## 1. 데이터 모델 변경 (`src/pages/CaseDrawer.tsx`)

### 1.1 `CaseRecord` 확장

```typescript
type CaseRecord = {
  id: string;
  folderName: string;
  name: string;
  startDate: string;
  labelColor?: string | null;
  genogram: FileRef;
  psychTests: ExtraDoc[];
  supervisions: ExtraDoc[];
  reports: ExtraDoc[];        // ← 신규: 완성된 보고서 목록
  sessions: SessionRecord[];
  basicInfo: BasicInfo;
};
```

- `reports`는 기존 `psychTests`/`supervisions`와 동형 — `ExtraDoc = { id, date, path, sessionNo?, note? }`. `note`에 "어느 양식으로 만들었는지"(templateId) 기록.
- `_사례정보.json`에 그대로 직렬화되므로 기존 저장 로직(useEffect 자동 저장) 변경 불필요 — 필드만 늘어남. 과거 파일(구버전 `_사례정보.json`, `reports` 필드 없음)을 읽을 때는 `parsed.reports || []`로 방어(기존 `basicInfo` 로드 코드의 방어 패턴과 동일 — `loadCasesFromFolder`).

### 1.2 신규 타입: 보고서 양식 등록

```typescript
type ReportSection =
  | { kind: "text";  key: string; title: string }
  | { kind: "table"; key: string; title: string }
  | { kind: "guide"; key: string; title: string; prompts: string[] };  // prompts = {{GUIDE:...}} 안 번호목록

type ReportTemplate = {
  id: string;
  name: string;            // 사용자가 붙인 보고서 종류 이름 (예: "참관자 보고서")
  formPath: string;        // 원본 hwpx 양식 경로 (경로로만 연결 — 복사 X, 기존 FileRef 철학과 동일)
  sections: ReportSection[]; // 등록 시 1회 파싱, 순서 확정
  registeredAt: string;
};

type ReportTemplateStore = { templates: ReportTemplate[] };
```

- 저장 위치: 사례별 데이터가 아니라 **사례서랍 루트 전역** — `<rootFolder>/_보고서양식.json`. 이유: 하나의 양식(보고서 종류)은 여러 내담자에게 공통으로 쓰이므로 사례 단위로 중복 등록할 필요가 없다.
- `caseDrawerAPI`(현재 `getSettings`/`setSettings`/`readText`/`writeText`/`selectFile` 등을 IPC로 제공하는 `preload.cjs` 브릿지)는 변경 없이 그대로 재사용 — `readText`/`writeText`로 `_보고서양식.json` 읽고 쓰면 됨. 신규 IPC 채널 추가 불필요.

---

## 2. 화면 컴포넌트 구조 (`src/pages/`)

```
CaseDrawer.tsx
  └─ CaseRow (기존)
       + "보고서 작성 책상" 버튼 (신규, CaseRow 액션 영역에 추가)
            └─ onOpenReportDesk(caseId) → 상위 라우팅으로 ReportDesk 화면 전환

ReportDesk.tsx (신규 파일, CaseDrawer.tsx와 형제)
  ├─ ReportTypePicker           : 등록된 ReportTemplate 목록에서 선택 (없으면 "양식 등록"으로 유도)
  ├─ TemplateRegisterDialog     : hwpx 선택 → 백엔드 파싱 호출 → 인식된 섹션 확인/조정 화면(안전망) → 저장
  └─ ReportWriteScreen          : 좌우 이등분 작성 화면
       ├─ ReferencePanel (좌)
       │    ├─ 탭 전환 바 (회차 선택 드롭다운 포함)
       │    └─ 파일별 뷰어 — 기존 FilePreviewDialog 내부 렌더 로직(오디오/이미지/텍스트/폴백)을
       │       모달이 아닌 인라인 패널 컴포넌트로 추출·재사용 (컴포넌트명 예: FileInlineViewer)
       └─ WritePanel (우)
            ├─ TextSection      (kind: "text")
            ├─ AiDraftSection   (kind: "text" + isAiAssisted 플래그, "AI 초안 생성" 버튼 포함)
            ├─ TableSection     (kind: "table", 붙여넣기 그리드)
            ├─ GuideSection     (kind: "guide", 하위질문 입력 N개 → 자동 연결)
            └─ "보고서 완성" 버튼 → POST /api/report/generate
```

- `FilePreviewDialog`의 내부 렌더 분기(오디오/이미지/텍스트/폴백, 163~203행)를 `FileInlineViewer`라는 순수 렌더 컴포넌트로 추출해 `FilePreviewDialog`(모달)와 `ReferencePanel`(인라인) 둘 다에서 재사용한다. 기존 모달 동작은 그대로 유지(회귀 없음).
- 섹션 유형 중 어떤 텍스트 섹션이 "AI 초안" 대상인지는 양식 등록 시 사용자가 지정(§1.2 확인 화면에서 "이 섹션은 AI 초안 도움받기" 체크박스) — 마커 자체에 별도 문법을 추가하지 않고(`{{SECTION:...}}`은 하나로 유지) 등록 확인 단계에서 플래그를 붙이는 방식이 마커 문법을 늘리지 않아 더 단순하다.

---

## 3. 백엔드 (`server/app.py`) — 신규 엔드포인트

기존 온디바이스 원칙(요약 590~900행)과 동일하게, 아래 엔드포인트도 전부 로컬 처리·외부 전송 없음.

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/report/template/parse` | hwpx 양식 경로 받아 `{{SECTION}}/{{TABLE}}/{{GUIDE}}` 마커 파싱 → `ReportSection[]` JSON 반환 (등록 확인 화면용, 파일 저장은 안 함) |
| POST | `/api/report/draft` | 회기 축어록(+기존 요약 있으면 함께) 받아 "보고서용 초안" 생성 — 기존 `_analyze_ask_llm`/`llama-completion.exe` 인프라 재사용, reduce 프롬프트만 신규 (§5.2 참조). SSE로 진행 스트리밍(기존 `/api/analyze/*`와 동일 패턴). |
| POST | `/api/report/generate` | 양식 경로 + 섹션별 채움 내용(JSON) + 표 데이터 받아 hwpx 치환·생성, 저장 경로 반환 |

### 3.1 hwpx 마커 파싱/치환 모듈 신설

`server/`에 새 모듈(예: `server/hwpx_report.py`)을 만들고, `~/.claude/skills/hwpx/scripts/parse.py`의 zip 안전 추출(`safe_extract_hwpx`)·섹션 로드(`load_sections`) 로직을 이식(포크)해 재사용한다. 신규 로직:

- **파싱**: `hp:p` 문단을 순회하며 텍스트에서 `{{SECTION:이름}}` / `{{/SECTION}}` 등 마커 문자열을 찾아 순서·유형·이름을 추출. 스타일 정보는 보지 않음(§4.2 근거).
- **치환**: 텍스트 마커(`{{SECTION:...}}...{{/SECTION}}` 사이, `{{필드명}}` 단일 마커 포함)는 해당 문단의 `<hp:t>` 텍스트 노드만 교체 — 원본 문단의 charPr/paraPr(폰트·자간·줄간격 등)는 건드리지 않으므로 서식이 그대로 보존된다(요구사항 §8 "정확하게 들어가게"의 핵심 근거).
- **표 삽입**: `{{TABLE:...}}` 마커가 있던 문단을, `~/.claude/skills/hwpx/scripts/build.py`의 `_table_xml` 생성 로직을 재사용해 만든 `hp:tbl` XML로 치환. 표 스타일(`table_header`/`table_cell`)은 `extract.py`로 원본 양식에서 뽑은 대표 서식을 그대로 사용(양식마다 다른 표 스타일 자동 반영).
- 완성 후 zip으로 재압축 저장 — `~/.claude/skills/hwpx/scripts/office/pack.py`의 압축 로직 재사용.
- **검증**: 기존 `~/.claude/skills/hwpx/scripts/verify.py`가 있으면 생성 직후 자체 검증(구조 깨짐 여부)에 재사용 검토 — impl-planner 단계에서 verify.py의 기존 용도(자체 생성 hwpx 검증)가 "기존 양식 치환 결과물" 검증에도 그대로 맞는지 확인 필요.

> 위 모듈은 `~/.claude/skills/hwpx/scripts/`를 **참조 구현으로 삼아 서버 안에 이식**하는 것이지, 스킬 스크립트를 런타임에 직접 import하지 않는다(스킬은 Claude 세션 도구이지 앱 런타임 의존성이 아님 — 앱은 오프라인 배포되는 독립 실행파일이어야 하므로 필요한 로직만 코드로 복사해 `server/` 안에 자체 보유해야 한다). 이 판단은 CLAUDE.md의 "온디바이스·독립 배포" 원칙과 정합.

### 3.2 AI 초안 프롬프트 (신규, `_ANALYZE_SYS_*` 옆에 추가)

```python
_REPORT_DRAFT_SYS = (
    "당신은 상담 축어록과 기존 회기요약을 바탕으로 보고서에 바로 쓸 수 있는 "
    "격식 있는 문어체 초안을 작성하는 조수다. 구어체·대화체를 쓰지 말고, "
    "관찰된 사실과 상담자의 개입을 구분해 서술하라. "
    "이 초안은 반드시 상담자의 검토를 거쳐야 하는 초안임을 전제로 작성하라."
)
```

- 입력: 기존 요약(있으면) + 선택된 회기(들)의 조각 요약(기존 map 단계 재사용).
- `_analyze_ask_llm` 함수 시그니처 그대로 재사용 가능(system/user 프롬프트만 교체).

---

## 4. 파일 구조 변경 요약

```
gongulbaki/
├── src/pages/
│   ├── CaseDrawer.tsx        # 수정: CaseRecord.reports 필드 추가, "보고서 작성 책상" 버튼
│   ├── ReportDesk.tsx         # 신규: 양식선택 + 등록 + 작성화면 전체
│   └── report/                # 신규 폴더 (컴포넌트 분리)
│       ├── ReferencePanel.tsx
│       ├── FileInlineViewer.tsx   # FilePreviewDialog에서 추출한 공용 렌더 로직
│       ├── TextSection.tsx
│       ├── AiDraftSection.tsx
│       ├── TableSection.tsx
│       └── GuideSection.tsx
├── server/
│   ├── app.py                 # 수정: /api/report/* 3개 엔드포인트 추가
│   └── hwpx_report.py         # 신규: 마커 파싱·치환·표삽입·압축 (hwpx 스킬 이식)
└── docsPlan/보고서작성책상/
    ├── requirements.md
    └── structure.md            # 이 문서
```

---

## 5. 열린 기술 확인 사항 (impl-planner 단계에서 착수 전 확정)

- `verify.py`가 "새로 만든 hwpx"뿐 아니라 "기존 양식을 부분 치환한 hwpx"에도 유효한 검증을 하는지 실물 hwpx로 스파이크 필요.
- 클립보드 HTML 표 paste 이벤트 파싱(브라우저 `clipboardData.getData("text/html")` → 표 구조 추출)의 병합 셀(`colspan`/`rowspan`) 처리 범위 — 병합 셀이 있는 실제 심리검사 표를 하나 받아서 검증 필요.
- PyInstaller로 `server/app.py`를 `app.exe`로 패키징하는 기존 빌드(`server/app.spec`)에 `hwpx_report.py`와 그 의존 라이브러리(zip 처리는 표준 라이브러리 `zipfile`이라 문제없을 것으로 예상, `lxml` 사용 시 번들 확인 필요 — hwpx 스킬은 lxml 없으면 `xml.etree`로 폴백하므로 최소 폴백 경로는 안전)가 정상 포함되는지 "배포 전 깨끗한 PC 검증" 원칙(feedback_dev_rules)에 따라 확인 필요.

---

## 6. 제외 범위

requirements.md §9와 동일 — 여기서 반복하지 않음.
