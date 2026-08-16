# 티켓④ — 사례서랍(CaseDrawer) 연동

> 선행: ② 완료(필수) · ③은 조건부(00-overview.md §3 확정 규칙 참조 — ③ 없이도 착수·완료 선언 가능, 단 "축어록+참고자료 동시 활용" 완료 조건 1개 항목만 ③ 완료 후 별도 검증) · 후행: 없음(마지막 티켓)

---

## 1. AS-IS (Read로 확인 — 가장 중요한 발견)

`src/pages/Index.tsx` 2833~2846행:
```tsx
<div style={{ display: activeTab === "genogram" ? "flex" : "none" }}>...<Genogram /></div>
<div style={{ display: activeTab === "cases" ? "flex" : "none" }}>...<CaseDrawer /></div>
<div style={{ display: activeTab === "transcribe" ? "flex" : "none" }}>...(분석 패널 포함)</div>
```
`Genogram`/`CaseDrawer`/축어록 패널은 **전부 `Index` 컴포넌트의 형제 자식**이며 항상 마운트된 채 `display:none`으로만 전환된다. `Index.tsx` 전체에서 `caseDrawerAPI`/`SessionRecord`/`sessionId` 문자열이 **0건**(grep 확인) — `CaseDrawer`는 props도 콜백도 없이 `<CaseDrawer />`로만 렌더링된다.

`src/pages/CaseDrawer.tsx`:
- 28~35행 `SessionRecord`: `{ no, date, audio, transcriptJson, transcriptWord, analysis }` — `analysis: FileRef`(경로+등록일만, 내용 없음).
- 621~626행: 회차 카드에서 "축어록"/"분석" 등 슬롯 클릭 시 `caseDrawerAPI.selectFile()`로 **기존 파일을 선택해 경로만 연결**(파일 내용을 그 자리에서 생성하지 않음) — "결과 저장" 같은 생성 액션이 CaseDrawer 안에 없다(요구사항 문서 142행 배경 서술과 일치: "기존에는 결과 저장 버튼을 눌러야 파일로 남는 구조" — 그 버튼은 CaseDrawer가 아니라 Index.tsx 분석 패널의 `saveAnalysis`(2587행)이며, 저장 후 CaseDrawer와 아무 연결이 없었다).
- `transcriptJson` FileRef: Index.tsx 자체 세션 저장 포맷(`{version, fileName, mode, rawText, lines, showTime}`, `CLAUDE.md` "세션 저장 형식" 문서화됨)과 **동일한 JSON 스키마**로 추정(같은 앱이 만드는 파일이므로) — 화자 라벨이 포함된 `Line[]` 구조라 채팅 컨텍스트로 쓰기에 `transcriptWord`(docx, mammoth로 열어야 함)보다 **`transcriptJson`을 우선 사용**하는 것이 구조적으로 자연스럽다.
- 1508~1575행: `settings.rootFolder` 기준으로 `cases`/`drawers`/`miscDocs` state를 `caseDrawerAPI.writeText`로 자동 저장하는 `useEffect` 패턴이 이미 있음 — **④가 `SessionRecord.analysis`를 갱신할 때도 이 자동저장 이펙트가 그대로 파일에 반영**되므로, 신규 저장 로직을 따로 만들 필요 없이 기존 `cases` state를 갱신하기만 하면 된다.

`preload.cjs`/`electron-main.cjs`: `case-write-text`(electron-main.cjs 236~244행)는 **임의의 절대 경로 + 내용 문자열**을 받아 그대로 쓴다 — 사례 전용 로직이 없다. **채팅에서 만든 요약 텍스트를 사례 폴더 안에 새 파일로 쓰는 데 이 핸들러를 그대로 재사용할 수 있다. 신규 IPC 불필요.**

## 2. TO-BE

### 2.1 Index.tsx — 상태 리프팅 (신규 작업, 기존 연결 확장이 아님)

```tsx
// Index.tsx 최상위 컴포넌트에 신규 상태 추가
const [chatContext, setChatContext] = useState<{
  caseDir: string; sessionNo: number; sessionDate: string; transcriptText: string;
} | null>(null);

// 2842행 근처
<CaseDrawer onOpenChat={(ctx) => { setChatContext(ctx); setActiveTab("transcribe"); }} />

// 축어록 탭의 AnalyzeChatPanel에 전달
<AnalyzeChatPanel chatContext={chatContext} onClearContext={() => setChatContext(null)} />
```

`CaseDrawer.tsx`는 `onOpenChat` prop을 새로 받아, 회차 카드에 **"채팅으로 분석" 버튼**(신규, structure.md 컴포넌트 트리와 일치)을 추가한다. 버튼 클릭 시:
1. `session.transcriptJson`이 있으면 `caseDrawerAPI.readText(path)` → `JSON.parse` → `lines` 배열을 텍스트로 재구성(화자 라벨 붙여서, 기존 Index.tsx의 축어록 표기 규칙과 동일 포맷)
2. 없고 `transcriptWord`만 있으면 `mammoth`(이미 CaseDrawer.tsx에 임포트돼 있음, 11~13행)로 docx 텍스트 추출 — **폴백 경로**, 우선순위는 JSON
3. `onOpenChat({ caseDir, sessionNo: session.no, sessionDate: session.date, transcriptText })` 호출

### 2.2 채팅 시작 시 컨텍스트 전달

`AnalyzeChatPanel`이 `chatContext`가 있으면 `/api/chat/new`에 `{ caseDir: chatContext.caseDir, linkedSessionId: "<caseDir>#<sessionNo>" }`를 보내 대화를 생성 — ②에서 정의한 계약 그대로 사용(신규 백엔드 변경 없음). 첫 시스템 프롬프트(또는 첫 user 턴)에 `chatContext.transcriptText`를 컨텍스트로 포함해 `/api/chat/send`에 실어 보낸다(구조 설계 3.4 — "context.sessionId를 CaseDrawer에서 채워 전달", 실제로는 sessionId 문자열보다 **텍스트 자체를 함께 보내는 편이 안전** — Flask 프로세스가 Electron이 관리하는 파일을 직접 열 권한/경로 규약이 없으므로, §00 overview §1-3 발견사항과 동일한 이유).

**컨텍스트 예산 초과 대응(안정성, Critical — ②-§2.3과 연결)**: `chatContext.transcriptText`는 회기 전체 축어록이라 길이가 상당할 수 있다(수만 자급, 기존 요약 파이프라인이 조각을 15~22개로 나눠야 했던 실측 사례가 이미 있음, MEMORY `project_kanana_engine_swap.md`). 이 텍스트를 **원문 그대로 매 턴 프롬프트에 반복 주입하지 않는다** — ②-§2.3의 2순위 규칙을 그대로 따라, 첫 대화 시작 시점에 축어록이 예산을 위협할 만큼 길면 ①의 map-reduce 요약 파이프라인으로 1회 압축("이 회기 요약본")한 뒤 그 압축본을 `conversation_id`에 캐시해 이후 턴에서 재사용한다(매 턴 재계산 없음, ②가 이미 설계한 캐시 지점을 ④가 재사용). 축어록이 짧아(예산 내) 압축이 불필요한 경우에만 원문을 그대로 쓴다 — "항상 압축"이 아니라 "예산 초과 시에만 압축".

### 2.3 결과를 `SessionRecord.analysis`에 저장 — 신규 IPC 없이 기존 패턴 재사용

```tsx
// AnalyzeChatPanel 안 "이 회기에 저장" 버튼(명시적 사용자 액션 — 요구사항 확정 원칙)
const saveToCase = async (summaryText: string) => {
  if (!chatContext) return;
  const filePath = joinPath(chatContext.caseDir, `${chatContext.sessionNo}회차_분석_채팅.txt`);
  await caseDrawerAPI.writeText(filePath, summaryText);          // 기존 IPC 그대로
  // 이후 CaseDrawer 쪽 cases state의 해당 SessionRecord.analysis를 { path: filePath, addedAt: now }로 갱신
  // → 1567~1575행의 기존 자동저장 useEffect가 _사례정보.json에 알아서 반영
};
```

이 갱신을 위해 `Index.tsx`가 `CaseDrawer`에 `onSaveAnalysis` 콜백도 함께 내려주거나(리프팅 방향 반대), `CaseDrawer`가 `chatContext`를 구독해 자신의 `cases` state를 직접 갱신하는 방식 중 **개발 단계에서 하나로 확정** — 어느 쪽이든 `cases` state 갱신 지점은 `CaseDrawer.tsx` 내부(1567~1575행 이펙트가 그 state를 감시)이므로 갱신 자체는 CaseDrawer 쪽 함수로 캡슐화하고 Index.tsx는 콜백만 연결하는 편이 컴포넌트 경계상 자연스럽다(권고).

**자동 덮어쓰기 없음 원칙**(요구사항 142행 고정 사항) — `saveToCase`는 사용자가 명시적으로 "이 회기에 저장" 버튼을 눌렀을 때만 호출, 채팅 스트리밍 완료 시 자동 호출하지 않는다.

**기존 파일이 이미 있을 때의 확인(Warning 대응)**: `${chatContext.sessionNo}회차_분석_채팅.txt` 경로에 **이미 이전 채팅에서 저장한 결과가 있는 경우**, `caseDrawerAPI.fileExists(filePath)`(이미 있는 IPC, `electron-main.cjs` 274~276행)로 먼저 확인한 뒤 `window.confirm("이미 저장된 분석 결과가 있습니다. 덮어쓸까요?")` 같은 명시적 확인 없이 조용히 덮어쓰지 않는다 — 기존 "회기 요약" 흐름의 `saveAnalysis`(Index.tsx 2587행)도 별도 확인 없이 그대로 저장하는 방식이었지만, 채팅은 세션마다 여러 번 저장을 시도할 가능성이 더 높아(대화 중 여러 차례 "요약해줘"를 요청할 수 있음) 덮어쓰기 사고 위험이 더 크다. 확인 후 진행을 선택하면 기존 파일을 덮어쓰고, 취소하면 파일명에 타임스탬프를 붙인 새 파일(`<N>회차_분석_채팅_2.txt` 등)로 저장할지 재질문 — 세부 UX는 개발 단계에서 확정하되 "확인 없는 덮어쓰기"는 배제한다.

### 2.4 축어록 + 참고자료 동시 활용

`chatContext.transcriptText`(④가 주입)와 ③의 검색 로직(참고자료 창고 전체 대상, 사례 무관)은 **서로 독립적인 두 컨텍스트 소스** — `/api/chat/send`가 (a) 대화 히스토리 (b) `linkedSessionId`가 있으면 그 축어록 텍스트 (c) 참고자료 검색 결과, 세 가지를 모두 프롬프트에 조립하는 구조. ③에서 만든 검색 함수 호출에 `linkedSessionId` 유무는 영향 주지 않음(사례 연결 여부와 무관하게 항상 전역 창고에서 검색) — 신규 분기 로직 최소화.

## 3. 다른 티켓과의 연결

- TICKET-②에서 받는 것: `/api/chat/new`의 `caseDir`/`linkedSessionId` 파라미터 계약, `Conversation.linkedSessionId` 타입.
- TICKET-③에서 받는 것: 참고자료 검색 함수(사례 연결 여부 무관 항상 호출).
- 공유 파일 주의: `src/pages/Index.tsx`(상태 리프팅 지점 — ②가 만든 `AnalyzeChatPanel` 렌더 지점과 동일 위치를 이 티켓이 다시 건드림, ②의 최종 코드 기준으로 diff), `src/pages/CaseDrawer.tsx`(621~626행 근처에 "채팅으로 분석" 버튼 추가 — 기존 `AttachSlot` 렌더링 옆).

## 4. 완료 조건

```
[ ] Index.tsx 최상위 chatContext 상태 추가, CaseDrawer↔AnalyzeChatPanel 형제 간 상태 리프팅 동작
[ ] CaseDrawer 회차 카드에 "채팅으로 분석" 버튼 추가 → transcriptJson 우선, transcriptWord 폴백으로 텍스트 추출
[ ] 채팅 시작 시 /api/chat/new에 caseDir/linkedSessionId 전달, 축어록 텍스트가 첫 컨텍스트로 주입됨 확인
[ ] "이 회기에 저장" 명시적 액션으로만 SessionRecord.analysis 갱신(자동저장 없음) 확인
[ ] 저장 경로에 기존 파일이 있을 때 확인 절차 없이 덮어쓰지 않음(§2.3 Warning 대응) 확인
[ ] 신규 파일이 caseDrawerAPI.writeText로 사례 폴더 안에 생성 + 기존 자동저장 이펙트로 _사례정보.json 반영 확인
[ ] 긴 축어록(수만 자급)을 채팅 컨텍스트로 연결했을 때 원문을 매 턴 반복 주입하지 않고 예산 초과 시 요약 압축으로 전환됨(§2.2, ②-§2.3 연결) 확인 — 에러/빈 응답 없이 정상 동작
[ ] 축어록 컨텍스트 + 참고자료(RAG) 컨텍스트 동시 활용 질의 정상 동작("이 회기를 이론 A 관점에서 봐줘" 류) — ③ 미완료 상태에서 이 항목을 검증할 때는 §00 overview §3 표의 조건부 처리 규칙 참조
[ ] SessionRecord에 신규 옵셔널 필드 추가 시 구버전 _사례정보.json(필드 없음) 로드 무오류 확인
[ ] 사례 데이터 외부 전송 없음 재확인(신규 엔드포인트 전부 127.0.0.1)
```
