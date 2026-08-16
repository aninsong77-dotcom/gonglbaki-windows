import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import Index from "./pages/Index";

// ⚠️임시 진단용 — 한글 조합창이 좌상단에 떨어지는 문제의 "두 번째 원인"을 찾기 위한 기록.
// 어쩌다 한 번씩만 나는 문제라 재현을 기다릴 수 없어서, 조합이 시작되는 순간의 상태만
// 조용히 남겨둔다(그때 무엇이 달랐는지 정상 사례와 대조하려는 것). 원인 확인 후 제거할 것.
//
// 기록하는 것: 입력칸의 화면상 위치, 조상 요소에 걸린 transform/animation(조합창 위치 계산을
// 틀어지게 하는 것으로 알려진 요인), 팝업 안인지 여부, 직전 포커스 이동 시각.
(() => {
  let lastFocusAt = 0;
  let lastFocusTag = "";
  window.addEventListener("focusin", (e) => {
    lastFocusAt = Date.now();
    lastFocusTag = (e.target as HTMLElement)?.tagName || "";
  }, true);

  // 조상들을 훑어 transform·animation·filter 가 걸린 요소를 모은다
  const quirksOf = (el: HTMLElement | null) => {
    const quirks: string[] = [];
    let node: HTMLElement | null = el;
    let depth = 0;
    while (node && depth < 12) {
      const cs = getComputedStyle(node);
      const bits: string[] = [];
      if (cs.transform && cs.transform !== "none") bits.push(`transform=${cs.transform}`);
      if (cs.animationName && cs.animationName !== "none") bits.push(`anim=${cs.animationName}`);
      if (cs.filter && cs.filter !== "none") bits.push(`filter=${cs.filter}`);
      if (cs.zoom && cs.zoom !== "1" && cs.zoom !== "normal") bits.push(`zoom=${cs.zoom}`);
      if (bits.length) quirks.push(`[${depth}]${node.tagName}.${(node.className || "").toString().slice(0, 40)} ${bits.join(" ")}`);
      node = node.parentElement;
      depth++;
    }
    return quirks;
  };

  // 커서(캐럿)의 상태 — 이번 문제의 핵심 단서.
  // 조합창이 화면 구석으로 떨어지는 건 크로미움이 "커서가 화면 어디에 있는지"를 못 구할 때다.
  // 그 상황이 실제로 벌어지고 있는지를 두 가지로 확인한다:
  //  - anchorAttached: 커서가 가리키는 글자 덩어리가 아직 화면(문서)에 붙어 있는가
  //  - caretRects: 커서 위치의 화면 좌표를 구할 수 있는가 (0 이면 못 구하는 상태 = 의심)
  // 글자 내용은 절대 남기지 않는다 — 길이만.
  const caretInfo = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { sel: "none" as const };
    const range = sel.getRangeAt(0);
    const anchor = sel.anchorNode;
    const probe = range.cloneRange();
    probe.collapse(true);
    const rects = probe.getClientRects();
    const first = rects[0];
    return {
      sel: "ok" as const,
      collapsed: sel.isCollapsed,
      anchorType: anchor ? (anchor.nodeType === Node.TEXT_NODE ? "#text" : (anchor as HTMLElement).tagName) : null,
      anchorAttached: anchor ? document.contains(anchor) : null,
      anchorLen: anchor?.textContent?.length ?? -1,
      caretRects: rects.length,
      caretAt: first ? { x: Math.round(first.left), y: Math.round(first.top) } : null,
    };
  };

  // 어떤 키를 눌렀는지는 "종류"만 남긴다 — 실제 글자는 절대 기록하지 않는다.
  // (상담 내용이 낱자 형태로라도 파일에 남지 않게 하기 위함. 원인 추적에는
  //  "글자키를 눌렀는데 조합이 시작되지 않았다"는 사실만 있으면 충분하다.)
  const keyKind = (e: KeyboardEvent) => {
    const k = e.key;
    if (!k) return "unknown";
    if (k.length === 1) return "문자키";  // t·ㅅ·3 등 — 무엇인지는 남기지 않는다
    return k;                             // Escape·Enter·Backspace·Process 등 기능키 이름만
  };

  const snapshot = (why: string, el: HTMLElement | null) => {
    const rect = el?.getBoundingClientRect?.();
    const active = document.activeElement as HTMLElement | null;
    return {
      t: new Date().toISOString(),
      why,
      tag: el?.tagName,
      editable: (el as any)?.isContentEditable ?? false,
      lineId: el?.getAttribute?.("data-line-id") || null,
      rect: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width) } : null,
      inDialog: !!el?.closest?.("[role=dialog]"),
      // 이벤트가 향한 칸과 실제로 포커스를 가진 칸이 어긋나 있으면 그것만으로 이상 신호다
      activeIsTarget: !!el && active === el,
      activeLineId: active?.getAttribute?.("data-line-id") || null,
      // 포커스가 잡힌 지 얼마 만인지 — 애니메이션 중 타이핑 여부 판별용
      msSinceFocus: lastFocusAt ? Date.now() - lastFocusAt : -1,
      lastFocusTag,
      caret: caretInfo(),
      quirks: quirksOf(el).slice(0, 6),
      devicePixelRatio: window.devicePixelRatio,
    };
  };

  const write = (data: unknown) => {
    try { console.warn("[IME진단] " + JSON.stringify(data)); } catch { /* 무시 */ }
  };

  window.addEventListener("compositionstart", (e) => {
    try { write(snapshot("조합시작", e.target as HTMLElement)); } catch { /* 진단이 앱을 방해하지 않도록 조용히 무시 */ }
  }, true);

  // 조합이 아예 시작되지 않는 경우(기호가 안 써지던 그 상황)도 잡아야 한다.
  // 다만 키를 칠 때마다 좌표를 재면 느려질 수 있어, 1초에 한 번만 살펴보고
  // "이상할 때"(커서 좌표를 못 구하거나, 커서가 떨어져 나간 글자 덩어리를 가리킬 때)만 기록한다.
  let lastProbeAt = 0;
  window.addEventListener("keydown", (e) => {
    try {
      const el = e.target as HTMLElement;
      if (!el?.isContentEditable && el?.tagName !== "TEXTAREA" && el?.tagName !== "INPUT") return;
      // Esc 는 한글 조합을 정리하는 키라 의심 대상이다 — 편집 중에 눌린 것은 언제나 남겨서,
      // 나중에 증상이 난 시각과 Esc 시각이 붙어 있는지 대조할 수 있게 한다.
      if (e.key === "Escape") {
        write({ ...snapshot("편집중Esc", el), isComposing: e.isComposing, keyKind: keyKind(e) });
        return;
      }
      const now = Date.now();
      if (now - lastProbeAt < 1000) return;
      lastProbeAt = now;
      const c = caretInfo();
      const bad = c.sel === "none" || c.caretRects === 0 || c.anchorAttached === false;
      if (!bad) return;
      write({ ...snapshot("커서이상", el), keyKind: keyKind(e), isComposing: e.isComposing });
    } catch { /* 무시 */ }
  }, true);

  // ── 증상 신고 단축키 (Ctrl+Shift+D) ──────────────────────────────
  // 증상은 어쩌다 한 번 나서, 우연히 그 순간에 자동 기록이 걸리기를 기다리는 것으로는
  // 잡히지 않았다(8/6~8/13 기록에 재현 0건). 그래서 이상하다고 느낀 순간을 사용자가
  // 직접 표시하게 한다 — 이게 "터진 순간"을 확보하는 가장 확실한 방법이다.
  // 앱 기능과 겹치지 않는 조합을 골랐다(기존 단축키: Space·Esc·Shift+화살표·Ctrl+S).
  const flash = (text: string) => {
    try {
      const box = document.createElement("div");
      box.textContent = text;
      box.style.cssText =
        "position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:2147483647;" +
        "background:#2d1f0e;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;";
      document.body.appendChild(box);
      setTimeout(() => box.remove(), 1800);
    } catch { /* 무시 */ }
  };

  window.addEventListener("keydown", (e) => {
    try {
      if (!e.ctrlKey || !e.shiftKey || (e.key !== "D" && e.key !== "d")) return;
      e.preventDefault();
      write({ ...snapshot("증상신고", document.activeElement as HTMLElement | null), isComposing: e.isComposing });
      flash("증상이 기록되었습니다 (Ctrl+Shift+D)");
    } catch { /* 무시 */ }
  }, true);
})();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Index />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
