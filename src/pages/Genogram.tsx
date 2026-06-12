import { useEffect, useRef, useState, useCallback } from "react";

// ─── 타입 ─────────────────────────────────────────────────────
type Gender = "남성" | "여성" | "논바이너리" | "레즈비언" | "게이" | "임신" | "사산아" | "자연유산" | "인공유산";
type LineType =
  | "결혼" | "별거" | "이혼" | "재결합" | "동거"
  | "소원" | "친밀" | "밀착" | "단절"
  | "갈등" | "융합된갈등"
  | "신체적학대" | "성적학대"
  | "약혼" | "사별"
  | "무관심"
  | "정서적학대" | "방임" | "통제";

type SubstanceType = "약물남용" | "정신신체문제" | "약물정신신체" | "약물남용의심" | "약물남용회복" | null;

interface GNode {
  id: string; gender: Gender; dead: boolean; client: boolean;
  substance: SubstanceType;
  label: string; age: string; x: number; y: number;
  identical?: boolean; // 일란성 쌍둥이
}
interface GLine { id: string; from: string; to: string; lineType: LineType; }
type ChildLineType = "일반" | "위탁" | "입양";
interface Marriage { id: string; childIds: string[]; childLineTypes?: Record<string, ChildLineType>; twinGroups?: string[][]; twinDropOffsets?: number[]; }
interface GTextBox { id: string; x: number; y: number; w: number; h: number; text: string; color: string; fontSize: number; }

const NS = 56, SNAP = 18, CHILD_DROP = 70;
const uid = () => Math.random().toString(36).slice(2, 9);

const FAMILY_TYPES: LineType[] = ["결혼", "별거", "이혼", "재결합", "동거", "약혼", "사별"];
const EMO_TYPES: LineType[] = ["소원", "친밀", "밀착", "단절"];
const CONFLICT_TYPES: LineType[] = ["갈등", "융합된갈등"];
const ABUSE_TYPES: LineType[] = ["신체적학대", "성적학대"];
const MARRIAGE_TYPES: LineType[] = ["결혼", "별거", "이혼", "재결합", "동거", "약혼", "사별"];

// 선 색상
function lineColor(lt: LineType, bw: boolean, sel: boolean): string {
  if (sel) return "#3a6a4a";
  if (bw) return "#222";
  if (["갈등", "융합된갈등", "신체적학대", "성적학대", "정서적학대", "방임", "통제", "단절", "소원", "무관심"].includes(lt)) return "#dc2626";
  if (lt === "친밀") return "#16a34a";
  if (lt === "밀착") return "#7c3aed";
  return "#222";
}

function nc(n: GNode) { return { x: n.x + NS / 2, y: n.y + NS / 2 }; }
// 특수자녀 연결점 (도형 상단)
function ncTop(n: GNode) {
  if (["자연유산", "인공유산", "임신", "사산아"].includes(n.gender)) return { x: n.x + NS/2, y: n.y + NS/2 - 15 };
  return { x: n.x + NS/2, y: n.y };
}

function getEndpoint(id: string, nodes: GNode[], lines: GLine[]) {
  const n = nodes.find(n => n.id === id);
  if (n) return nc(n);
  const l = lines.find(l => l.id === id);
  if (l) {
    const p1 = getEndpoint(l.from, nodes, lines);
    const p2 = getEndpoint(l.to, nodes, lines);
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }
  return { x: 0, y: 0 };
}

function offsetPts(x1: number, y1: number, x2: number, y2: number, off: number) {
  const a = Math.atan2(y2 - y1, x2 - x1), p = a + Math.PI / 2;
  return { x1: x1 + Math.cos(p) * off, y1: y1 + Math.sin(p) * off, x2: x2 + Math.cos(p) * off, y2: y2 + Math.sin(p) * off };
}

function sharpZigzag(x1: number, y1: number, x2: number, y2: number, amp = 11) {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const segLen = 20;
  const segs = Math.max(4, Math.round(dist / segLen));
  const dx = (x2 - x1) / segs, dy = (y2 - y1) / segs;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * amp, ny = (dx / len) * amp;
  let d = `M ${x1} ${y1}`;
  for (let i = 1; i <= segs; i++) {
    const mx = x1 + dx * (i - 0.5) + (i % 2 === 0 ? nx : -nx);
    const my = y1 + dy * (i - 0.5) + (i % 2 === 0 ? ny : -ny);
    d += ` L ${mx} ${my} L ${x1 + dx * i} ${y1 + dy * i}`;
  }
  return d;
}

function waveZigzag(x1: number, y1: number, x2: number, y2: number, amp = 10) {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const segLen = 22;
  const segs = Math.max(3, Math.round(dist / segLen));
  const dx = (x2 - x1) / segs, dy = (y2 - y1) / segs;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * amp, ny = (dx / len) * amp;
  let d = `M ${x1} ${y1}`;
  for (let i = 0; i < segs; i++) {
    const sx = x1 + dx * i, sy = y1 + dy * i, ex = x1 + dx * (i + 1), ey = y1 + dy * (i + 1);
    const s = i % 2 === 0 ? 1 : -1;
    d += ` C ${sx + dx * 0.25 + nx * s} ${sy + dy * 0.25 + ny * s} ${sx + dx * 0.75 + nx * s} ${sy + dy * 0.75 + ny * s} ${ex} ${ey}`;
  }
  return d;
}

// 선 미리보기
function LinePreview({ type, size = 38, bw = false }: { type: LineType; size?: number; bw?: boolean }) {
  const h = 16, w = size, mid = h / 2;
  const col = bw ? "#222" : lineColor(type, false, false);
  const gray = "#222";

  if (type === "결혼") return <svg width={w} height={h}><line x1={2} y1={mid} x2={w - 2} y2={mid} stroke={gray} strokeWidth={3} /></svg>;
  if (type === "별거") return <svg width={w} height={h}>
    <line x1={2} y1={mid} x2={w - 2} y2={mid} stroke={gray} strokeWidth={2} />
    <line x1={w / 2 - 3} y1={mid + 6} x2={w / 2 + 3} y2={mid - 6} stroke={gray} strokeWidth={2} />
  </svg>;
  if (type === "이혼") return <svg width={w} height={h}>
    <line x1={2} y1={mid} x2={w - 2} y2={mid} stroke={gray} strokeWidth={2} />
    <line x1={w / 2 - 7} y1={mid + 6} x2={w / 2 - 1} y2={mid - 6} stroke={gray} strokeWidth={2} />
    <line x1={w / 2 + 1} y1={mid + 6} x2={w / 2 + 7} y2={mid - 6} stroke={gray} strokeWidth={2} />
  </svg>;
  if (type === "재결합") return <svg width={w} height={h}>
    <line x1={2} y1={mid} x2={w - 2} y2={mid} stroke={gray} strokeWidth={2} />
    <line x1={w / 2 - 5} y1={mid + 6} x2={w / 2 - 1} y2={mid - 6} stroke={gray} strokeWidth={2} />
    <line x1={w / 2 + 1} y1={mid + 6} x2={w / 2 + 5} y2={mid - 6} stroke={gray} strokeWidth={2} />
    <line x1={w / 2 - 8} y1={mid - 8} x2={w / 2 + 8} y2={mid + 8} stroke={gray} strokeWidth={2} />
  </svg>;
  if (type === "동거") return <svg width={w} height={h}><line x1={2} y1={mid} x2={w - 2} y2={mid} stroke={gray} strokeWidth={2} strokeDasharray="10 5" /></svg>;
  if (type === "소원") return <svg width={w} height={h}><line x1={2} y1={mid} x2={w - 2} y2={mid} stroke={col} strokeWidth={1.5} strokeDasharray="2 3" /></svg>;
  if (type === "친밀") return <svg width={w} height={h}>
    <line x1={2} y1={mid - 3} x2={w - 2} y2={mid - 3} stroke={col} strokeWidth={2} />
    <line x1={2} y1={mid + 3} x2={w - 2} y2={mid + 3} stroke={col} strokeWidth={2} />
  </svg>;
  if (type === "밀착") return <svg width={w} height={h}>
    <line x1={2} y1={mid - 5} x2={w - 2} y2={mid - 5} stroke={col} strokeWidth={2} />
    <line x1={2} y1={mid} x2={w - 2} y2={mid} stroke={col} strokeWidth={2} />
    <line x1={2} y1={mid + 5} x2={w - 2} y2={mid + 5} stroke={col} strokeWidth={2} />
  </svg>;
  if (type === "단절") return <svg width={w} height={h}>
    <line x1={2} y1={mid} x2={w / 2 - 6} y2={mid} stroke={col} strokeWidth={2} />
    <line x1={w / 2 + 6} y1={mid} x2={w - 2} y2={mid} stroke={col} strokeWidth={2} />
    <line x1={w / 2 - 6} y1={mid - 6} x2={w / 2 - 6} y2={mid + 6} stroke={col} strokeWidth={2} />
    <line x1={w / 2 + 6} y1={mid - 6} x2={w / 2 + 6} y2={mid + 6} stroke={col} strokeWidth={2} />
  </svg>;
  if (type === "갈등") return <svg width={w} height={h}><path d={`M2,${mid} L8,3 L14,${h - 3} L20,3 L26,${h - 3} L${w - 2},${mid}`} stroke={col} strokeWidth={2} fill="none" /></svg>;
  if (type === "융합된갈등") return <svg width={w} height={h}>
    <path d={`M2,${mid - 4} L8,1 L14,${h - 5} L20,1 L26,${h - 5} L${w - 2},${mid - 4}`} stroke={col} strokeWidth={1.5} fill="none" />
    <path d={`M2,${mid + 4} L8,5 L14,${h - 1} L20,5 L26,${h - 1} L${w - 2},${mid + 4}`} stroke={col} strokeWidth={1.5} fill="none" />
  </svg>;
  if (type === "신체적학대") return <svg width={w} height={h}>
    <path d={`M2,${mid} C7,${mid - 5} 11,${mid + 5} 16,${mid} C21,${mid - 5} 25,${mid + 5} ${w - 8},${mid}`} stroke={col} strokeWidth={2} fill="none" />
    <polygon points={`${w - 2},${mid} ${w - 9},${mid - 4} ${w - 9},${mid + 4}`} fill={col} />
  </svg>;
  if (type === "성적학대") return <svg width={w} height={h}>
    <path d={`M2,${mid} L8,3 L14,${h - 3} L20,3 L${w - 8},${mid}`} stroke={col} strokeWidth={2} fill="none" />
    <polygon points={`${w - 2},${mid} ${w - 9},${mid - 4} ${w - 9},${mid + 4}`} fill={col} />
  </svg>;
  if (type === "약혼") return <svg width={w} height={h}>
    <line x1={2} y1={mid} x2={w-2} y2={mid} stroke={gray} strokeWidth={2} />
    <circle cx={w/2} cy={mid} r={3} fill="white" stroke={gray} strokeWidth={1.5} />
  </svg>;
  if (type === "사별") return <svg width={w} height={h}>
    <line x1={2} y1={mid} x2={w-2} y2={mid} stroke={gray} strokeWidth={2} />
    <line x1={w/2} y1={mid-5} x2={w/2} y2={mid+5} stroke={gray} strokeWidth={2} />
  </svg>;
  if (type === "무관심") return <svg width={w} height={h}>
    <line x1={2} y1={mid} x2={w-2} y2={mid} stroke={col} strokeWidth={1.5} strokeDasharray="8 5" />
  </svg>;
  if (type === "정서적학대") return <svg width={w} height={h}>
    <line x1={2} y1={mid} x2={w-8} y2={mid} stroke={col} strokeWidth={2} strokeDasharray="5 3" />
    <polygon points={`${w-2},${mid} ${w-9},${mid-4} ${w-9},${mid+4}`} fill={col} />
  </svg>;
  if (type === "방임") return <svg width={w} height={h}>
    <line x1={2} y1={mid} x2={w-8} y2={mid} stroke={col} strokeWidth={1.5} strokeDasharray="3 4" />
    <polygon points={`${w-2},${mid} ${w-9},${mid-4} ${w-9},${mid+4}`} fill={col} />
  </svg>;
  if (type === "통제") return <svg width={w} height={h}>
    <line x1={9} y1={mid} x2={w-9} y2={mid} stroke={col} strokeWidth={2.5} />
    <polygon points={`${w-2},${mid} ${w-9},${mid-4} ${w-9},${mid+4}`} fill={col} />
    <polygon points={`2,${mid} ${9},${mid-4} ${9},${mid+4}`} fill={col} />
  </svg>;
  return null;
}

// 두 줄 버튼
function TwoLineBtn({ top, bottom, onClick, active, disabled, danger, preview, bw }: {
  top?: string; bottom: string; onClick: () => void;
  active?: boolean; disabled?: boolean; danger?: boolean;
  preview?: LineType; bw?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`flex flex-col items-center justify-center px-1.5 py-1 rounded border text-[9px] font-medium transition-colors leading-tight min-w-[36px] gap-0.5
        ${danger ? "border-red-200 text-red-500 hover:bg-red-50 bg-white"
          : active ? "border-[#3a6a4a] bg-[#f0f7f2] text-[#2d7a3a]"
          : "border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2] hover:border-[#3a6a4a]"}
        ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}>
      {preview ? <LinePreview type={preview} size={32} bw={bw} /> : <span className="text-[10px]">{top}</span>}
      <span className="text-[10px]">{bottom}</span>
    </button>
  );
}



// ─── 메인 ─────────────────────────────────────────────────────
export default function Genogram() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [nodes, setNodes] = useState<GNode[]>([]);
  const [lines, setLines] = useState<GLine[]>([]);
  const [marriages, setMarriages] = useState<Marriage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lineType, setLineType] = useState<LineType>("결혼");
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [connectingMode, setConnectingMode] = useState<"node" | "child">("node");
  const [childLineType, setChildLineType] = useState<"일반" | "위탁" | "입양">("일반");
  const [twinSelectMode, setTwinSelectMode] = useState(false);
  const [twinPending, setTwinPending] = useState<string[]>([]); // 쌍둥이로 묶을 자녀 id
  const [twinIdentical, setTwinIdentical] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editField, setEditField] = useState<"label" | "age">("label");
  const [editVal, setEditVal] = useState("");
  const [bw, setBw] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [textBoxes, setTextBoxes] = useState<GTextBox[]>([]);
  const [textBoxMode, setTextBoxMode] = useState(false);
  const [textBoxColor, setTextBoxColor] = useState("#222222");
  const [editingTbId, setEditingTbId] = useState<string | null>(null);
  const tbDragRef = useRef<{ id: string; type: "move" | "resize"; ox: number; oy: number; initW?: number; initH?: number } | null>(null);
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  // 범례
  const [legendPos, setLegendPos] = useState<{ x: number; y: number } | null>(null);
  const [legendBoxW, setLegendBoxW] = useState(210);
  const [legendBoxH, setLegendBoxH] = useState(0); // 0 = auto
  const [legendFontScale, setLegendFontScale] = useState(1.0);
  const [legendSelected, setLegendSelected] = useState(false);
  const [legendVisible, setLegendVisible] = useState(true);
  const [legendLabelOverrides, setLegendLabelOverrides] = useState<Record<string, string>>({});
  const [editingLegendKey, setEditingLegendKey] = useState<string | null>(null);
  const legendDragRef = useRef<{ type: "move" | "resizeBox" | "resizeFont"; ox: number; oy: number; initW?: number; initH?: number; initF?: number } | null>(null);

  // Undo
  const [history, setHistory] = useState<{ nodes: GNode[]; lines: GLine[]; marriages: Marriage[]; textBoxes: GTextBox[] }[]>([]);
  const saveHistory = useCallback(() => {
    setHistory(h => [...h.slice(-30), { nodes: nodes.map(n => ({ ...n })), lines: lines.map(l => ({ ...l })), marriages: marriages.map(m => ({ ...m, childIds: [...m.childIds] })), textBoxes: textBoxes.map(t => ({ ...t })) }]);
  }, [nodes, lines, marriages]);
  const undo = useCallback(() => {
    setHistory(h => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      setNodes(prev.nodes); setLines(prev.lines); setMarriages(prev.marriages); setTextBoxes(prev.textBoxes ?? []);
      return h.slice(0, -1);
    });
  }, []);

  const dragRef = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const spaceRef = useRef(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [rubber, setRubber] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const rbStart = useRef<{ x: number; y: number } | null>(null);

  // 캔버스 실제 크기를 state로 관리 — display:none 탭에서 돌아올 때도 정확히 업데이트
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 500 });

  // ── 줌 / 패닝 ──
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const isPanning = useRef(false);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setCanvasSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const svgPt = (cx: number, cy: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    // 줌/패닝 보정: 화면 좌표 → 캔버스 좌표
    return {
      x: (cx - r.left - pan.x) / zoom,
      y: (cy - r.top - pan.y) / zoom,
    };
  };

  // 종료 확인 모달은 Index.tsx에서 처리

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
      if (e.key === "Delete" || e.key === "Backspace") doDelete();
      if (e.key === "Escape") { setSelected(new Set()); setConnectingFrom(null); setLegendSelected(false); }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") undo();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selected, nodes, lines, marriages, history]);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const editing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (e.code === "Space" && !editing) {
        e.preventDefault();
        spaceRef.current = true;
        setSpaceDown(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space") { spaceRef.current = false; setSpaceDown(false); }
    };
    const onBlur = () => { spaceRef.current = false; setSpaceDown(false); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const addNode = (gender: Gender) => {
    saveHistory();
    const r = wrapRef.current?.getBoundingClientRect();
    const x = r ? r.width / 2 - NS / 2 + (Math.random() - 0.5) * 120 : 200;
    const y = r ? r.height / 3 + (Math.random() - 0.5) * 80 : 150;
    setNodes(p => [...p, { id: uid(), gender, dead: false, client: false, substance: ["임신","사산아","자연유산","인공유산"].includes(gender) ? null : null, label: "", age: "", x, y }]);
  };

  const toggleDead = () => {
    const sel = Array.from(selected).filter(id => nodes.some(n => n.id === id));
    if (!sel.length) return;
    saveHistory();
    setNodes(p => p.map(n => sel.includes(n.id) ? { ...n, dead: !n.dead } : n));
  };

  const toggleSubstance = (type: SubstanceType) => {
    const sel = Array.from(selected).filter(id => nodes.some(n => n.id === id));
    if (!sel.length) return;
    saveHistory();
    setNodes(p => p.map(n => sel.includes(n.id) ? { ...n, substance: n.substance === type ? null : type } : n));
  };

  const toggleClient = useCallback(() => {
    const sel = Array.from(selected).filter(id => nodes.some(n => n.id === id));
    if (!sel.length) return;
    saveHistory();
    setNodes(p => p.map(n => sel.includes(n.id) ? { ...n, client: !n.client } : n));
  }, [selected, nodes, saveHistory]);

  const snapPos = (x: number, y: number, excludeId: string) => {
    let sx = x, sy = y;
    const cx = x + NS / 2, cy = y + NS / 2;
    const MARRIAGE_SNAP = 32;

    // 노드끼리 스냅
    for (const n of nodes) {
      if (n.id === excludeId) continue;
      if (Math.abs(n.x - x) < SNAP) sx = n.x;
      if (Math.abs(n.y - y) < SNAP) sy = n.y;
      if (Math.abs((n.x + NS / 2) - (x + NS / 2)) < SNAP) sx = n.x;
      if (Math.abs((n.y + NS / 2) - (y + NS / 2)) < SNAP) sy = n.y;
    }

    // 결혼선 중앙 아래에 스냅 (자녀 철컥)
    for (const m of marriages) {
      const ml = lines.find(l => l.id === m.id);
      if (!ml) continue;
      const p1 = getEndpoint(ml.from, nodes, lines);
      const p2 = getEndpoint(ml.to, nodes, lines);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const targetX = midX - NS / 2;
      const targetY = midY + CHILD_DROP - NS / 2;
      if (Math.abs(cx - midX) < MARRIAGE_SNAP && Math.abs(cy - (midY + CHILD_DROP)) < MARRIAGE_SNAP) {
        sx = targetX;
        sy = targetY;
      }
    }

    return { x: sx, y: sy };
  };

  const doDelete = useCallback(() => {
    // 범례 삭제
    if (legendSelected) { setLegendVisible(false); setLegendSelected(false); return; }
    // 텍스트박스 삭제
    if (textBoxes.some(t => selected.has(t.id))) {
      saveHistory();
      setTextBoxes(p => p.filter(t => !selected.has(t.id)));
      setSelected(new Set());
      return;
    }
    if (!selected.size) return;
    saveHistory();
    const sel = new Set(selected);
    setNodes(p => p.filter(n => !sel.has(n.id)));
    setLines(p => p.filter(l => !sel.has(l.id) && !sel.has(l.from) && !sel.has(l.to)));
    setMarriages(p => p.map(m => {
      if (sel.has(m.id)) return null;
      const rem = m.childIds.filter(c => !sel.has(c));
      return rem.length === 0 ? null : { ...m, childIds: rem };
    }).filter(Boolean) as Marriage[]);
    setSelected(new Set());
  }, [selected, legendSelected, saveHistory]);

  const connectNodes = (fromId: string, toId: string, lt: LineType) => {
    saveHistory();
    const key = (a: string, b: string) => [a, b].sort().join(":");
    const pairKey = key(fromId, toId);
    const isFamily = FAMILY_TYPES.includes(lt as any);
    setLines(prev => {
      let next = [...prev];
      if (isFamily) {
        const removed = next.filter(l => key(l.from, l.to) === pairKey && FAMILY_TYPES.includes(l.lineType as any));
        removed.forEach(r => setMarriages(m => m.filter(mm => mm.id !== r.id)));
        next = next.filter(l => !(key(l.from, l.to) === pairKey && FAMILY_TYPES.includes(l.lineType as any)));
      } else {
        next = next.filter(l => !(key(l.from, l.to) === pairKey && !FAMILY_TYPES.includes(l.lineType as any)));
      }
      const newLine: GLine = { id: uid(), from: fromId, to: toId, lineType: lt };
      if (MARRIAGE_TYPES.includes(lt)) setMarriages(m => [...m, { id: newLine.id, childIds: [] }]);
      return [...next, newLine];
    });
  };

  const handleNodeClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (connectingFrom !== null) {
      if (connectingMode === "child") {
        saveHistory();
        setMarriages(p => p.map(m => m.id === connectingFrom ? {
          ...m,
          childIds: [...new Set([...m.childIds, id])],
          childLineTypes: { ...m.childLineTypes, [id]: childLineType }
        } : m));
        setConnectingFrom(null); return;
      }
      if (connectingFrom === id) { setConnectingFrom(null); return; }
      connectNodes(connectingFrom, id, lineType);
      setConnectingFrom(null); return;
    }
    if (e.shiftKey) { setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
    else { setSelected(p => p.size === 1 && p.has(id) ? new Set() : new Set([id])); }
  };

  const handleLineClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (connectingFrom !== null) { setConnectingFrom(null); return; }
    if (e.shiftKey) { setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
    else { setSelected(p => p.size === 1 && p.has(id) ? new Set() : new Set([id])); }
  };

  const handleLineRightClick = (e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation();
    if (marriages.some(m => m.id === id)) { setConnectingFrom(id); setConnectingMode("child"); }
  };

  const handleNodeRightClick = (e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation();
    setConnectingFrom(id); setConnectingMode("node");
  };

  const onNodeDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (connectingFrom) return;
    const pt = svgPt(e.clientX, e.clientY);
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    if (!selected.has(id) && !e.shiftKey) setSelected(new Set([id]));
    dragRef.current = { id, ox: pt.x - node.x, oy: pt.y - node.y };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    // 패닝 중
    if (isPanning.current && panRef.current) {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      setPan({ x: panRef.current.panX + dx, y: panRef.current.panY + dy });
      return;
    }
    if (dragRef.current) {
      const pt = svgPt(e.clientX, e.clientY);
      const { id, ox, oy } = dragRef.current;
      if (selected.has(id) && selected.size > 1) {
        const cur = nodes.find(n => n.id === id);
        if (cur) {
          const snapped = snapPos(pt.x - ox, pt.y - oy, id);
          const dx = snapped.x - cur.x, dy = snapped.y - cur.y;
          setNodes(p => p.map(n => selected.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n));
        }
      } else {
        const snapped = snapPos(pt.x - ox, pt.y - oy, id);
        setNodes(p => p.map(n => n.id === id ? { ...n, x: snapped.x, y: snapped.y } : n));
      }
    }
    if (rbStart.current) {
      const pt = svgPt(e.clientX, e.clientY);
      setRubber({ x: Math.min(rbStart.current.x, pt.x), y: Math.min(rbStart.current.y, pt.y), w: Math.abs(pt.x - rbStart.current.x), h: Math.abs(pt.y - rbStart.current.y) });
    }
    if (tbDragRef.current) {
      const pt = svgPt(e.clientX, e.clientY);
      const { id, type, ox, oy, initW, initH } = tbDragRef.current;
      if (type === "move") {
        setTextBoxes(p => p.map(t => t.id === id ? { ...t, x: pt.x - ox, y: pt.y - oy } : t));
      } else if (type === "resize") {
        setTextBoxes(p => p.map(t => t.id === id ? { ...t, w: Math.max(60, (initW || 100) + (pt.x - ox)), h: Math.max(30, (initH || 40) + (pt.y - oy)) } : t));
      }
    }
    if (legendDragRef.current) {
      const pt = svgPt(e.clientX, e.clientY);
      const { type, ox, oy, initW, initH, initF } = legendDragRef.current;
      if (type === "move") {
        setLegendPos({ x: pt.x - ox, y: pt.y - oy });
      } else if (type === "resizeBox") {
        const dw = pt.x - ox, dh = pt.y - oy;
        setLegendBoxW(Math.max(140, (initW || 210) + dw));
        if (initH) setLegendBoxH(Math.max(80, initH + dh));
      } else if (type === "resizeFont") {
        const dy = oy - pt.y; // 위로 드래그하면 커짐
        setLegendFontScale(Math.max(0.5, Math.min(2.5, (initF || 1) + dy / 80)));
      }
    }
  };

  const onMouseUp = () => {
    if (isPanning.current) { isPanning.current = false; panRef.current = null; return; }
    if (rubber && rubber.w > 4 && rubber.h > 4) {
      const { x, y, w, h } = rubber;
      const s = new Set<string>();
      nodes.forEach(n => { const cx = n.x + NS / 2, cy = n.y + NS / 2; if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) s.add(n.id); });
      lines.forEach(l => { const p1 = getEndpoint(l.from, nodes, lines), p2 = getEndpoint(l.to, nodes, lines); const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2; if (mx >= x && mx <= x + w && my >= y && my <= y + h) s.add(l.id); });
      if (s.size) setSelected(s);
    }
    dragRef.current = null; rbStart.current = null; legendDragRef.current = null; tbDragRef.current = null; setRubber(null);
  };

  const onCanvasDown = (e: React.MouseEvent) => {
    if ((e.target as Element).tagName !== "svg") return;
    setLegendSelected(false);
    // 스페이스+드래그, 가운데 버튼, Alt+클릭 → 패닝
    if (spaceRef.current || e.button === 1 || e.altKey) {
      isPanning.current = true;
      panRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
      e.preventDefault();
      return;
    }
    if (textBoxMode) {
      const pt = svgPt(e.clientX, e.clientY);
      saveHistory();
      const nb: GTextBox = { id: uid(), x: pt.x, y: pt.y, w: 120, h: 40, text: "텍스트", color: textBoxColor, fontSize: 14 };
      setTextBoxes(p => [...p, nb]);
      setEditingTbId(nb.id);
      setTextBoxMode(false);
      return;
    }
    if (!connectingFrom) { setSelected(new Set()); rbStart.current = svgPt(e.clientX, e.clientY); }
  };

  // non-passive wheel: React onWheel은 passive라 preventDefault가 브라우저 줌을 막지 못함
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mouseX = e.clientX - r.left;
      const mouseY = e.clientY - r.top;
      // deltaY 비례 줌: 트랙패드(작은 deltaY)는 느리게, 마우스휠(큰 deltaY)은 적당히
      const factor = Math.pow(0.999, e.deltaY);
      setZoom(prev => {
        const next = Math.min(4, Math.max(0.2, prev * factor));
        setPan(p => ({
          x: mouseX - (mouseX - p.x) * (next / prev),
          y: mouseY - (mouseY - p.y) * (next / prev),
        }));
        return next;
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const startEdit = (e: React.MouseEvent, id: string, field: "label" | "age") => {
    e.stopPropagation(); e.preventDefault(); dragRef.current = null;
    const node = nodes.find(n => n.id === id); if (!node) return;
    setEditId(id); setEditField(field); setEditVal(field === "label" ? node.label : node.age);
  };
  const commitEdit = () => {
    if (!editId) return;
    setNodes(p => p.map(n => n.id === editId ? { ...n, [editField]: editVal } : n));
    setEditId(null);
  };

  const saveImg = () => {
    const svg = svgRef.current; if (!svg || !nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(n => { minX = Math.min(minX, n.x - 10); minY = Math.min(minY, n.y - 10); maxX = Math.max(maxX, n.x + NS + 10); maxY = Math.max(maxY, n.y + NS + 30); });
    const canvasW = wrapRef.current?.clientWidth || canvasSize.w, canvasH = wrapRef.current?.clientHeight || canvasSize.h;
    const lx = legendPos?.x ?? (canvasW - legendBoxW - 16), ly = legendPos?.y ?? (canvasH - 300);
    minX = Math.min(minX, lx - 10); minY = Math.min(minY, ly - 10);
    maxX = Math.max(maxX, lx + legendBoxW + 10); maxY = Math.max(maxY, ly + (legendBoxH || 400) + 10);
    const pad = 20;
    const data = new XMLSerializer().serializeToString(svg);
    const modified = data.replace(/viewBox="[^"]*"/, `viewBox="${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}"`);
    const blob = new Blob([modified], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "가계도.svg"; a.click(); URL.revokeObjectURL(url);
    setShowSaveMenu(false);
  };

  const saveJson = () => {
    const data = JSON.stringify({
      version: 1,
      nodes, lines, marriages, textBoxes,
      legendPos, legendBoxW, legendBoxH, legendFontScale, legendLabelOverrides, legendVisible, bw,
    }, null, 2);
    const blob = new Blob([data], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "가계도.json"; a.click();
    URL.revokeObjectURL(url);
    setShowSaveMenu(false);
  };

  const loadJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.version !== 1) { alert("지원하지 않는 가계도 파일 형식입니다."); return; }
        saveHistory();
        setNodes(data.nodes ?? []);
        setLines(data.lines ?? []);
        setMarriages(data.marriages ?? []);
        setTextBoxes(data.textBoxes ?? []);
        if (data.legendPos !== undefined) setLegendPos(data.legendPos);
        if (data.legendBoxW !== undefined) setLegendBoxW(data.legendBoxW);
        if (data.legendBoxH !== undefined) setLegendBoxH(data.legendBoxH);
        if (data.legendFontScale !== undefined) setLegendFontScale(data.legendFontScale);
        if (data.legendLabelOverrides !== undefined) setLegendLabelOverrides(data.legendLabelOverrides);
        if (data.legendVisible !== undefined) setLegendVisible(data.legendVisible);
        if (data.bw !== undefined) setBw(data.bw);
      } catch { alert("가계도 JSON 파일을 읽을 수 없습니다."); }
    };
    reader.readAsText(file, "utf-8");
  };

  // 저장 메뉴 외부 클릭 시 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target as Node)) {
        setShowSaveMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 노드 경계까지만 선이 닿도록 끝점을 조정 (화살표가 도형 위에 보이게)
  const clipToNodeBoundary = (cx: number, cy: number, tx: number, ty: number, nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return { x: tx, y: ty };
    const r = NS / 2 + 2; // 노드 반경 + 여백
    const dx = tx - cx, dy = ty - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return { x: tx, y: ty };
    return { x: tx - (dx / dist) * r, y: ty - (dy / dist) * r };
  };

  // 선 렌더
  const renderLine = (l: GLine) => {
    const isEmo = !FAMILY_TYPES.includes(l.lineType as any);
    const rawP1 = getEndpoint(l.from, nodes, lines), rawP2 = getEndpoint(l.to, nodes, lines);
    const isSel = selected.has(l.id);
    const col = lineColor(l.lineType, bw, isSel);
    const { x1, y1, x2, y2 } = isEmo ? offsetPts(rawP1.x, rawP1.y, rawP2.x, rawP2.y, 10) : { x1: rawP1.x, y1: rawP1.y, x2: rawP2.x, y2: rawP2.y };

    const hit = <path key="hit" d={`M ${x1} ${y1} L ${x2} ${y2}`} stroke="#000" strokeWidth={22} opacity={0} fill="none" pointerEvents="stroke" />;
    const elems: React.ReactNode[] = [hit];

    const angle = Math.atan2(y2 - y1, x2 - x1);
    const perpX = Math.cos(angle + Math.PI / 2), perpY = Math.sin(angle + Math.PI / 2);
    const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;

    if (l.lineType === "결혼") {
      elems.push(<line key="l" x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={3} />);
    } else if (l.lineType === "별거") {
      // 연결된 선 + 중간에 "/" 방향 사선 1개 (화면 기준 고정)
      elems.push(
        <line key="l" x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={2} />,
        <line key="sl"
          x1={midX - 4} y1={midY + 8}
          x2={midX + 4} y2={midY - 8}
          stroke={col} strokeWidth={2} />
      );
    } else if (l.lineType === "이혼") {
      // 연결된 선 + 중간에 "/" 방향 사선 2개 (화면 기준 고정)
      elems.push(<line key="l" x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={2} />);
      [-6, 6].forEach((offset, i) => {
        const ox = Math.cos(angle) * offset, oy = Math.sin(angle) * offset;
        elems.push(<line key={`sl${i}`}
          x1={midX + ox - 4} y1={midY + oy + 8}
          x2={midX + ox + 4} y2={midY + oy - 8}
          stroke={col} strokeWidth={2} />);
      });
    } else if (l.lineType === "재결합") {
      // // + \ 재결합 기호 — 세 선이 같은 중심에 겹침
      elems.push(<line key="l" x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={2} />);
      // / / 두 선 — 가깝게 붙임
      [-3, 3].forEach((offset, i) => {
        const ox = Math.cos(angle) * offset, oy = Math.sin(angle) * offset;
        elems.push(<line key={`sl${i}`}
          x1={midX + ox - 4} y1={midY + oy + 7}
          x2={midX + ox + 4} y2={midY + oy - 7}
          stroke={col} strokeWidth={2} />);
      });
      // \ 한 선 — 더 길게 가로지름
      elems.push(<line key="sr"
        x1={midX - 9} y1={midY - 9}
        x2={midX + 9} y2={midY + 9}
        stroke={col} strokeWidth={2} />);
    } else if (l.lineType === "동거") {
      elems.push(<line key="l" x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={2} strokeDasharray="12 6" />);
    } else if (l.lineType === "소원") {
      elems.push(<line key="l" x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={1.5} strokeDasharray="2 3" />);
    } else if (l.lineType === "친밀") {
      const o1 = offsetPts(x1, y1, x2, y2, 3.5), o2 = offsetPts(x1, y1, x2, y2, -3.5);
      elems.push(<line key="d1" x1={o1.x1} y1={o1.y1} x2={o1.x2} y2={o1.y2} stroke={col} strokeWidth={2} />);
      elems.push(<line key="d2" x1={o2.x1} y1={o2.y1} x2={o2.x2} y2={o2.y2} stroke={col} strokeWidth={2} />);
    } else if (l.lineType === "밀착") {
      [-5, 0, 5].forEach((off, i) => { const o = offsetPts(x1, y1, x2, y2, off); elems.push(<line key={`t${i}`} x1={o.x1} y1={o.y1} x2={o.x2} y2={o.y2} stroke={col} strokeWidth={2} />); });
    } else if (l.lineType === "단절") {
      // 두 선이 끊겨 있고, 끊긴 양쪽 끝에 수직 세로선
      const gap = 14;
      const ex1x = midX - Math.cos(angle) * gap, ex1y = midY - Math.sin(angle) * gap;
      const ex2x = midX + Math.cos(angle) * gap, ex2y = midY + Math.sin(angle) * gap;
      elems.push(
        <line key="l1" x1={x1} y1={y1} x2={ex1x} y2={ex1y} stroke={col} strokeWidth={2} />,
        <line key="l2" x1={ex2x} y1={ex2y} x2={x2} y2={y2} stroke={col} strokeWidth={2} />,
        <line key="bar1"
          x1={ex1x - perpX * 8} y1={ex1y - perpY * 8}
          x2={ex1x + perpX * 8} y2={ex1y + perpY * 8}
          stroke={col} strokeWidth={2} />,
        <line key="bar2"
          x1={ex2x - perpX * 8} y1={ex2y - perpY * 8}
          x2={ex2x + perpX * 8} y2={ex2y + perpY * 8}
          stroke={col} strokeWidth={2} />
      );
    } else if (l.lineType === "갈등") {
      elems.push(<path key="l" d={sharpZigzag(x1, y1, x2, y2)} stroke={col} strokeWidth={2} fill="none" />);
    } else if (l.lineType === "융합된갈등") {
      const o1 = offsetPts(x1, y1, x2, y2, 4), o2 = offsetPts(x1, y1, x2, y2, -4);
      elems.push(<path key="z1" d={sharpZigzag(o1.x1, o1.y1, o1.x2, o1.y2)} stroke={col} strokeWidth={1.5} fill="none" />);
      elems.push(<path key="z2" d={sharpZigzag(o2.x1, o2.y1, o2.x2, o2.y2)} stroke={col} strokeWidth={1.5} fill="none" />);
    } else if (l.lineType === "신체적학대") {
      const tip = clipToNodeBoundary(x1, y1, x2, y2, l.to);
      const tipAngle = Math.atan2(tip.y - y1, tip.x - x1);
      const arrowLen = 14;
      const pathD = waveZigzag(x1, y1, tip.x - Math.cos(tipAngle) * arrowLen, tip.y - Math.sin(tipAngle) * arrowLen);
      elems.push(<path key="w" d={pathD} stroke={col} strokeWidth={2} fill="none" />);
      elems.push(<polygon key="a" points={`${tip.x},${tip.y} ${tip.x - Math.cos(tipAngle - Math.PI / 6) * arrowLen},${tip.y - Math.sin(tipAngle - Math.PI / 6) * arrowLen} ${tip.x - Math.cos(tipAngle + Math.PI / 6) * arrowLen},${tip.y - Math.sin(tipAngle + Math.PI / 6) * arrowLen}`} fill={col} />);
    } else if (l.lineType === "성적학대") {
      const tip = clipToNodeBoundary(x1, y1, x2, y2, l.to);
      const tipAngle = Math.atan2(tip.y - y1, tip.x - x1);
      const arrowLen = 14;
      const pathD = sharpZigzag(x1, y1, tip.x - Math.cos(tipAngle) * arrowLen, tip.y - Math.sin(tipAngle) * arrowLen);
      elems.push(<path key="z" d={pathD} stroke={col} strokeWidth={2} fill="none" />);
      elems.push(<polygon key="a" points={`${tip.x},${tip.y} ${tip.x - Math.cos(tipAngle - Math.PI / 6) * arrowLen},${tip.y - Math.sin(tipAngle - Math.PI / 6) * arrowLen} ${tip.x - Math.cos(tipAngle + Math.PI / 6) * arrowLen},${tip.y - Math.sin(tipAngle + Math.PI / 6) * arrowLen}`} fill={col} />);
    } else if (l.lineType === "약혼") {
      elems.push(<line key="l" x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={2} />);
      elems.push(<circle key="c" cx={midX} cy={midY} r={4} fill="white" stroke={col} strokeWidth={1.5} />);
    } else if (l.lineType === "사별") {
      elems.push(<line key="l" x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={2} />);
      // 선에 수직인 십자 표시
      const cl = 10;
      elems.push(
        <line key="c"
          x1={midX + perpX * cl} y1={midY + perpY * cl}
          x2={midX - perpX * cl} y2={midY - perpY * cl}
          stroke={col} strokeWidth={2} />
      );
    } else if (l.lineType === "무관심") {
      elems.push(<line key="l" x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={1.5} strokeDasharray="8 5" />);
    } else if (l.lineType === "정서적학대") {
      const tip = clipToNodeBoundary(x1, y1, x2, y2, l.to);
      const tipAngle = Math.atan2(tip.y - y1, tip.x - x1);
      const arrowLen = 12;
      elems.push(<line key="l" x1={x1} y1={y1} x2={tip.x - Math.cos(tipAngle) * arrowLen} y2={tip.y - Math.sin(tipAngle) * arrowLen} stroke={col} strokeWidth={2} strokeDasharray="5 3" />);
      elems.push(<polygon key="a" points={`${tip.x},${tip.y} ${tip.x - Math.cos(tipAngle - Math.PI/6)*arrowLen},${tip.y - Math.sin(tipAngle - Math.PI/6)*arrowLen} ${tip.x - Math.cos(tipAngle + Math.PI/6)*arrowLen},${tip.y - Math.sin(tipAngle + Math.PI/6)*arrowLen}`} fill={col} />);
    } else if (l.lineType === "방임") {
      const tip = clipToNodeBoundary(x1, y1, x2, y2, l.to);
      const tipAngle = Math.atan2(tip.y - y1, tip.x - x1);
      const arrowLen = 12;
      elems.push(<line key="l" x1={x1} y1={y1} x2={tip.x - Math.cos(tipAngle) * arrowLen} y2={tip.y - Math.sin(tipAngle) * arrowLen} stroke={col} strokeWidth={1.5} strokeDasharray="3 4" />);
      elems.push(<polygon key="a" points={`${tip.x},${tip.y} ${tip.x - Math.cos(tipAngle - Math.PI/6)*arrowLen},${tip.y - Math.sin(tipAngle - Math.PI/6)*arrowLen} ${tip.x - Math.cos(tipAngle + Math.PI/6)*arrowLen},${tip.y - Math.sin(tipAngle + Math.PI/6)*arrowLen}`} fill={col} />);
    } else if (l.lineType === "통제") {
      const tip2 = clipToNodeBoundary(x1, y1, x2, y2, l.to);
      const tip1 = clipToNodeBoundary(x2, y2, x1, y1, l.from);
      const angle = Math.atan2(tip2.y - tip1.y, tip2.x - tip1.x);
      const arrowLen = 12;
      elems.push(<line key="l" x1={tip1.x} y1={tip1.y} x2={tip2.x} y2={tip2.y} stroke={col} strokeWidth={2.5} />);
      elems.push(<polygon key="a2" points={`${tip2.x},${tip2.y} ${tip2.x - Math.cos(angle - Math.PI/6)*arrowLen},${tip2.y - Math.sin(angle - Math.PI/6)*arrowLen} ${tip2.x - Math.cos(angle + Math.PI/6)*arrowLen},${tip2.y - Math.sin(angle + Math.PI/6)*arrowLen}`} fill={col} />);
      const angle2 = angle + Math.PI;
      elems.push(<polygon key="a1" points={`${tip1.x},${tip1.y} ${tip1.x - Math.cos(angle2 - Math.PI/6)*arrowLen},${tip1.y - Math.sin(angle2 - Math.PI/6)*arrowLen} ${tip1.x - Math.cos(angle2 + Math.PI/6)*arrowLen},${tip1.y - Math.sin(angle2 + Math.PI/6)*arrowLen}`} fill={col} />);
    }
    return elems;
  };

  const renderMarriage = (m: Marriage) => {
    const ml = lines.find(l => l.id === m.id); if (!ml) return null;
    const p1 = getEndpoint(ml.from, nodes, lines), p2 = getEndpoint(ml.to, nodes, lines);
    const children = m.childIds.map(cid => nodes.find(n => n.id === cid)).filter(Boolean) as GNode[];
    if (!children.length) return null;
    const midX = (p1.x + p2.x) / 2, parentY = (p1.y + p2.y) / 2, dropY = parentY + CHILD_DROP;
    const xs = children.map(c => nc(c).x);
    const topOf = (c: GNode) => ["임신","사산아","자연유산","인공유산"].includes(c.gender) ? ncTop(c) : { x: nc(c).x, y: c.y };
    const col = "#374151"; const sw = 2;
    const twinGroups = m.twinGroups || [];
    const twinIds = new Set(twinGroups.flat());
    const nonTwinChildren = children.filter(c => !twinIds.has(c.id));

    return (
      <g key={`m-${m.id}`}>
        {/* ── 비쌍둥이 자녀 선 ── */}
        {nonTwinChildren.length === 1 ? (() => {
          // 자녀 1명: parentY → 자녀 도형 상단까지 전체를 특수선으로
          const c = nonTwinChildren[0];
          const clt = m.childLineTypes?.[c.id] || "일반";
          const cx = nc(c).x;
          const ty = topOf(c).y;
          if (clt === "위탁") return (
            <line key={c.id} x1={midX} y1={parentY} x2={cx} y2={ty} stroke={col} strokeWidth={sw} strokeDasharray="6 4" />
          );
          if (clt === "입양") return (
            <g key={c.id}>
              <line x1={midX - 3} y1={parentY} x2={cx - 3} y2={ty} stroke={col} strokeWidth={sw} />
              <line x1={midX + 3} y1={parentY} x2={cx + 3} y2={ty} stroke={col} strokeWidth={sw} strokeDasharray="5 4" />
            </g>
          );
          // 일반
          return <line key={c.id} x1={midX} y1={parentY} x2={cx} y2={ty} stroke={col} strokeWidth={sw} />;
        })() : nonTwinChildren.length > 1 ? (
          // 자녀 2명 이상: 기존 방식 (수직선 → 수평바 → 각 자녀)
          <>
            <line x1={midX} y1={parentY} x2={midX} y2={dropY} stroke={col} strokeWidth={sw} />
            <line x1={Math.min(...nonTwinChildren.map(c => nc(c).x))} y1={dropY} x2={Math.max(...nonTwinChildren.map(c => nc(c).x))} y2={dropY} stroke={col} strokeWidth={sw} />
            {nonTwinChildren.map(c => {
              const clt = m.childLineTypes?.[c.id] || "일반";
              const cx = nc(c).x;
              const ty = topOf(c).y;
              if (clt === "위탁") return <line key={c.id} x1={cx} y1={dropY} x2={cx} y2={ty} stroke={col} strokeWidth={sw} strokeDasharray="6 4" />;
              if (clt === "입양") return (
                <g key={c.id}>
                  <line x1={cx - 3} y1={dropY} x2={cx - 3} y2={ty} stroke={col} strokeWidth={sw} />
                  <line x1={cx + 3} y1={dropY} x2={cx + 3} y2={ty} stroke={col} strokeWidth={sw} strokeDasharray="5 4" />
                </g>
              );
              return <line key={c.id} x1={cx} y1={dropY} x2={cx} y2={ty} stroke={col} strokeWidth={sw} />;
            })}
          </>
        ) : null}
        {twinGroups.map((group, gi) => {
          const gc = group.map(id => nodes.find(n => n.id === id)).filter(Boolean) as GNode[];
          if (gc.length < 2) return null;
          const gxs = gc.map(c => nc(c).x);
          const gMid = (Math.min(...gxs) + Math.max(...gxs)) / 2;
          const isIdentical = gc.some(c => c.identical);
          const childMidY = Math.min(...gc.map(c => nc(c).y));
          return (
            <g key={gi}>
              {/* 역V: 결혼선(parentY)에서 수직선 없이 바로 각 자녀로 연결 */}
              {gc.map(c => {
                const clt = m.childLineTypes?.[c.id] || "일반";
                const ty = topOf(c).y;
                const cx = nc(c).x;
                if (clt === "위탁") return <line key={c.id} x1={gMid} y1={parentY} x2={cx} y2={ty} stroke={col} strokeWidth={sw} strokeDasharray="6 4" />;
                if (clt === "입양") return <g key={c.id}>
                  <line x1={gMid - 3} y1={parentY} x2={cx - 3} y2={ty} stroke={col} strokeWidth={sw} />
                  <line x1={gMid + 3} y1={parentY} x2={cx + 3} y2={ty} stroke={col} strokeWidth={sw} strokeDasharray="5 4" />
                </g>;
                return <line key={c.id} x1={gMid} y1={parentY} x2={cx} y2={ty} stroke={col} strokeWidth={sw} />;
              })}
              {/* 일란성: 도형 중심 높이에 가로 연결선 */}
              {isIdentical && <line x1={Math.min(...gxs)} y1={childMidY} x2={Math.max(...gxs)} y2={childMidY} stroke={col} strokeWidth={sw} />}
            </g>
          );
        })}
      </g>
    );
  };

  const renderShape = (n: GNode, isSel: boolean, isConn: boolean) => {
    const s = isSel ? "#3a6a4a" : isConn ? "#f59e0b" : "#222";
    const sw = isSel || isConn ? 3 : 2, half = NS / 2;

    // 특수 자녀 도형 — 기본 도형 그리기 전에 early return
    if (n.gender === "임신") {
      const cx = NS/2, by = NS/2 + 15, ty = NS/2 - 15, hw = 17;
      return <g key={n.id}><polygon points={`${cx},${ty} ${cx+hw},${by} ${cx-hw},${by}`} fill="white" stroke={s} strokeWidth={sw} /></g>;
    }
    if (n.gender === "사산아") {
      const sz = NS * 0.5;
      const ox = (NS - sz) / 2;
      const oy = (NS - sz) / 2;
      return <g key={n.id}>
        <rect x={ox} y={oy} width={sz} height={sz} fill="white" stroke={s} strokeWidth={sw} />
        <line x1={ox+4} y1={oy+4} x2={ox+sz-4} y2={oy+sz-4} stroke={s} strokeWidth={sw} />
        <line x1={ox+sz-4} y1={oy+4} x2={ox+4} y2={oy+sz-4} stroke={s} strokeWidth={sw} />
      </g>;
    }
    if (n.gender === "자연유산") {
      const cx = NS/2, by = NS/2 + 15, ty = NS/2 - 15, hw = 17;
      return <g key={n.id}>
        <polygon points={`${cx},${ty} ${cx+hw},${by} ${cx-hw},${by}`} fill="white" stroke={s} strokeWidth={sw} />
        <line x1={cx-8} y1={NS/2-4} x2={cx+8} y2={NS/2+8} stroke={s} strokeWidth={sw} />
        <line x1={cx+8} y1={NS/2-4} x2={cx-8} y2={NS/2+8} stroke={s} strokeWidth={sw} />
      </g>;
    }
    if (n.gender === "인공유산") {
      const cx = NS/2, by = NS/2 + 15, ty = NS/2 - 15, hw = 17;
      return <g key={n.id}>
        <polygon points={`${cx},${ty} ${cx+hw},${by} ${cx-hw},${by}`} fill="white" stroke={s} strokeWidth={sw} />
        <line x1={cx-8} y1={NS/2-4} x2={cx+8} y2={NS/2+8} stroke={s} strokeWidth={sw} />
        <line x1={cx+8} y1={NS/2-4} x2={cx-8} y2={NS/2+8} stroke={s} strokeWidth={sw} />
        <line x1={cx-hw+2} y1={by-5} x2={cx+hw-2} y2={by-5} stroke={s} strokeWidth={sw} />
      </g>;
    }

    const parts: React.ReactNode[] = [];
    const gap = 4; // 이중도형 간격

    if (n.gender === "남성") {
      if (n.client) parts.push(<rect key="outer" x={0} y={0} width={NS} height={NS} fill="#fff" stroke={s} strokeWidth={sw} />);
      parts.push(<rect key="s" x={n.client ? gap : 3} y={n.client ? gap : 3} width={NS - (n.client ? gap * 2 : 6)} height={NS - (n.client ? gap * 2 : 6)} fill="#fff" stroke={s} strokeWidth={sw} />);
    } else if (n.gender === "여성") {
      if (n.client) parts.push(<circle key="outer" cx={half} cy={half} r={half} fill="#fff" stroke={s} strokeWidth={sw} />);
      parts.push(<circle key="s" cx={half} cy={half} r={n.client ? half - gap : half - 3} fill="#fff" stroke={s} strokeWidth={sw} />);
    } else if (n.gender === "레즈비언") {
      // 원 (삼각형은 substance 패턴 이후 맨 마지막에 그림)
      if (n.client) parts.push(<circle key="outer" cx={half} cy={half} r={half} fill="#fff" stroke={s} strokeWidth={sw} />);
      const lr = n.client ? half - gap - 3 : half - 3;
      parts.push(<circle key="s" cx={half} cy={half} r={lr} fill="#fff" stroke={s} strokeWidth={sw} />);
    } else if (n.gender === "게이") {
      // 사각형 (삼각형은 substance 패턴 이후 맨 마지막에 그림)
      if (n.client) parts.push(<rect key="outer" x={0} y={0} width={NS} height={NS} fill="#fff" stroke={s} strokeWidth={sw} />);
      const gi2 = n.client ? gap : 3;
      parts.push(<rect key="s" x={gi2} y={gi2} width={NS - gi2 * 2} height={NS - gi2 * 2} fill="#fff" stroke={s} strokeWidth={sw} />);
    } else {
      // 논바이너리 마름모
      if (n.client) parts.push(<polygon key="outer" points={`${half},0 ${NS},${half} ${half},${NS} 0,${half}`} fill="#fff" stroke={s} strokeWidth={sw} />);
      parts.push(<polygon key="s" points={`${half},${n.client ? gap + 1 : 3} ${NS - (n.client ? gap + 1 : 3)},${half} ${half},${NS - (n.client ? gap + 1 : 3)} ${n.client ? gap + 1 : 3},${half}`} fill="#fff" stroke={s} strokeWidth={sw} />);
    }
    // 약물남용 패턴
    if (n.substance === "약물남용") {
      // 아래 절반 검정 채움 — 성별 도형 클리핑
      if (n.gender === "남성" || n.gender === "게이") {
        const inner = n.client ? 4 : 3;
        parts.push(<rect key="sub" x={inner} y={NS/2} width={NS - inner*2} height={NS/2 - inner} fill="#222" stroke="none" />);
      } else if (n.gender === "여성" || n.gender === "레즈비언") {
        parts.push(<path key="sub" d={`M ${half} ${half} m -${half-3} 0 a ${half-3} ${half-3} 0 0 0 ${(half-3)*2} 0 Z`} fill="#222" stroke="none" />);
      } else {
        parts.push(<path key="sub" d={`M 3,${half} L ${half},${NS-3} L ${NS-3},${half} Z`} fill="#222" stroke="none" />);
      }
    } else if (n.substance === "정신신체문제") {
      // 좌측 절반 검정 채움
      if (n.gender === "남성" || n.gender === "게이") {
        const inner = n.client ? 4 : 3;
        parts.push(<rect key="sub" x={inner} y={inner} width={NS/2 - inner} height={NS - inner*2} fill="#222" stroke="none" />);
      } else if (n.gender === "여성" || n.gender === "레즈비언") {
        parts.push(<path key="sub" d={`M ${half} 3 a ${half-3} ${half-3} 0 0 0 0 ${(half-3)*2} Z`} fill="#222" stroke="none" />);
      } else {
        parts.push(<path key="sub" d={`M 3,${half} L ${half},3 L ${half},${NS-3} Z`} fill="#222" stroke="none" />);
      }
    } else if (n.substance === "약물정신신체") {
      // 3/4 검정 채움 (우상단 1/4만 비움)
      if (n.gender === "남성" || n.gender === "게이") {
        const inner = n.client ? 4 : 3;
        parts.push(<rect key="sub" x={inner} y={inner} width={NS - inner*2} height={NS - inner*2} fill="#222" stroke="none" />);
        parts.push(<rect key="sub2" x={NS/2} y={inner} width={NS/2 - inner} height={NS/2 - inner} fill="white" stroke="none" />);
      } else if (n.gender === "여성" || n.gender === "레즈비언") {
        parts.push(<path key="sub" d={`M ${half} ${half} L ${NS-3} ${half} A ${half-3} ${half-3} 0 1 1 ${half} 3 Z`} fill="#222" stroke="none" />);
      } else {
        parts.push(<path key="sub" d={`M ${half},3 L ${NS-3},${half} L ${half},${NS-3} L 3,${half} Z`} fill="#222" stroke="none" />);
        parts.push(<path key="sub2" d={`M ${half},3 L ${NS-3},${half} L ${half},${half} Z`} fill="white" stroke="none" />);
      }
    } else if (n.substance === "약물남용의심") {
      // 아래 절반 회색 채움
      if (n.gender === "남성" || n.gender === "게이") {
        const inner = n.client ? 4 : 3;
        parts.push(<rect key="sub" x={inner} y={NS/2} width={NS - inner*2} height={NS/2 - inner} fill="#999" stroke="none" />);
      } else if (n.gender === "여성" || n.gender === "레즈비언") {
        parts.push(<path key="sub" d={`M ${half} ${half} m -${half-3} 0 a ${half-3} ${half-3} 0 0 0 ${(half-3)*2} 0 Z`} fill="#999" stroke="none" />);
      } else {
        parts.push(<path key="sub" d={`M 3,${half} L ${half},${NS-3} L ${NS-3},${half} Z`} fill="#999" stroke="none" />);
      }
    } else if (n.substance === "약물남용회복") {
      // 우하단 1/4 검정 + 좌하단 1/4 회색
      if (n.gender === "남성" || n.gender === "게이") {
        const inner = n.client ? 4 : 3;
        parts.push(<rect key="sub1" x={NS/2} y={NS/2} width={NS/2 - inner} height={NS/2 - inner} fill="#999" stroke="none" />);
        parts.push(<rect key="sub2" x={inner} y={NS/2} width={NS/2 - inner} height={NS/2 - inner} fill="#222" stroke="none" />);
      } else if (n.gender === "여성" || n.gender === "레즈비언") {
        parts.push(<path key="sub1" d={`M ${half} ${half} L ${NS-3} ${half} A ${half-3} ${half-3} 0 0 1 ${half} ${NS-3} Z`} fill="#999" stroke="none" />);
        parts.push(<path key="sub2" d={`M ${half} ${half} L 3 ${half} A ${half-3} ${half-3} 0 0 0 ${half} ${NS-3} Z`} fill="#222" stroke="none" />);
      } else {
        parts.push(<path key="sub1" d={`M ${half},${half} L ${NS-3},${half} L ${half},${NS-3} Z`} fill="#999" stroke="none" />);
        parts.push(<path key="sub2" d={`M ${half},${half} L 3,${half} L ${half},${NS-3} Z`} fill="#222" stroke="none" />);
      }
    }
    // 특수 자녀 도형 — 중심 NS/2 기준, 작은 크기
    if (n.dead) { parts.push(<line key="x1" x1={8} y1={8} x2={NS - 8} y2={NS - 8} stroke={s} strokeWidth={sw} />, <line key="x2" x1={NS - 8} y1={8} x2={8} y2={NS - 8} stroke={s} strokeWidth={sw} />); }
    // 레즈비언/게이: 속빈 역삼각형을 맨 마지막에 그려서 substance 패턴 위에 표시
    if (n.gender === "레즈비언") {
      const lr = n.client ? half - gap - 3 : half - 3;
      const lt = lr - 5;
      const pts = `${half},${half + lt} ${half - lt},${half - lt * 0.6} ${half + lt},${half - lt * 0.6}`;
      parts.push(<polygon key="tri-outline" points={pts} fill="none" stroke="white" strokeWidth={sw + 2} />);
      parts.push(<polygon key="tri" points={pts} fill="none" stroke={s} strokeWidth={sw} />);
    }
    if (n.gender === "게이") {
      const gi2 = n.client ? gap : 3;
      const gt = (NS - gi2 * 2) / 2 - 4;
      const pts = `${half},${half + gt} ${half - gt},${half - gt * 0.6} ${half + gt},${half - gt * 0.6}`;
      parts.push(<polygon key="tri-outline" points={pts} fill="none" stroke="white" strokeWidth={sw + 2} />);
      parts.push(<polygon key="tri" points={pts} fill="none" stroke={s} strokeWidth={sw} />);
    }
    return parts;
  };

  // 범례: 실제 사용된 조합 추출
  type LegendNodeEntry = { key: string; gender: Gender; dead: boolean; client: boolean; substance: SubstanceType; label: string };
  const usedNodeEntries: LegendNodeEntry[] = [];
  const seenKeys = new Set<string>();
  for (const n of nodes) {
    const key = `${n.gender}_${n.dead ? "dead" : ""}_${n.client ? "client" : ""}_${n.substance ?? ""}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      const subLabel = n.substance === "약물남용" ? "약물남용" : n.substance === "정신신체문제" ? "정신신체문제" : n.substance === "약물정신신체" ? "약물+정신/신체" : n.substance === "약물남용의심" ? "약물남용 의심" : n.substance === "약물남용회복" ? "약물남용 회복" : null;
      const deadLabel = n.dead ? "(사망)" : "";
      const clientLabel = n.client ? "(내담자)" : "";
      const label = `${n.gender}${subLabel ? `(${subLabel})` : ""}${deadLabel}${clientLabel}`;
      usedNodeEntries.push({ key, gender: n.gender, dead: n.dead, client: n.client, substance: n.substance, label });
    }
  }
  const usedNodes = usedNodeEntries; // 하위 호환용
  const usedLineTypes = [...new Set(lines.map(l => l.lineType))];

  // 자녀 라인 (일반/위탁/입양) — marriages에서 실제 사용된 것만
  const usedChildLineTypesSet = new Set<ChildLineType>();
  for (const m of marriages) {
    for (const cid of m.childIds) {
      usedChildLineTypesSet.add(m.childLineTypes?.[cid] || "일반");
    }
  }
  const usedChildLineTypes: ChildLineType[] = (["일반", "위탁", "입양"] as ChildLineType[]).filter(t => usedChildLineTypesSet.has(t));

  // 쌍둥이 라인 — twinGroups에서 일란성/이란성 구분
  let hasIdenticalTwin = false, hasFraternalTwin = false;
  for (const m of marriages) {
    for (const group of (m.twinGroups || [])) {
      const gc = group.map(id => nodes.find(n => n.id === id)).filter(Boolean) as GNode[];
      if (gc.some(c => c.identical)) hasIdenticalTwin = true;
      else hasFraternalTwin = true;
    }
  }
  const twinEntries: string[] = [];
  if (hasFraternalTwin) twinEntries.push("이란성쌍둥이");
  if (hasIdenticalTwin) twinEntries.push("일란성쌍둥이");

  const totalItems = usedNodeEntries.length + usedLineTypes.length + usedChildLineTypes.length + twinEntries.length;
  const canvasW = canvasSize.w, canvasH = canvasSize.h;
  const lx = legendPos?.x ?? (canvasW - legendBoxW - 16);
  // autoH: 2열 여부에 따른 실제 높이 근사 계산
  const _cols = legendBoxW >= 240 ? 2 : 1;
  const _rowH = 22 * legendFontScale;
  const _secH = 17 * legendFontScale;
  const _sectionDefs = [
    { count: usedNodeEntries.length },
    { count: usedLineTypes.length },
    { count: usedChildLineTypes.length },
    { count: twinEntries.length },
  ].filter(s => s.count > 0);
  const autoH = 24 * legendFontScale + _sectionDefs.reduce((sum, s) => sum + _secH + Math.ceil(s.count / _cols) * _rowH + 4, 0) + 6;
  const lh = legendBoxH > 0 ? legendBoxH : autoH;
  const ly = legendPos?.y ?? (canvasH - lh - 16);

  const lineCategories = [
    { label: "가족\n관계", types: FAMILY_TYPES },
    { label: "감정\n관계선", types: EMO_TYPES },
    { label: "학대\n갈등", types: [...CONFLICT_TYPES, ...ABUSE_TYPES] },
  ];

  return (
    <div className="flex flex-col h-full" style={{ fontFamily: "'Malgun Gothic', sans-serif" }}>

      {/* ── 상단 툴바 ── */}
      <div className="bg-white border-b border-gray-200 px-2 flex flex-col shrink-0 overflow-x-auto overflow-y-hidden">


        {/* ── 1행: 인물 | 선종류 | 쌍둥이 ── */}
        <div className="flex items-center gap-1 py-1 border-b border-gray-100" style={{ flexShrink: 0, minWidth: "max-content" }}>
        {/* 인물 */}
        <div className="flex items-center gap-1 shrink-0" data-tour="geo-nodes">
          <TwoLineBtn top="□" bottom="남성" onClick={() => addNode("남성")} />
          <TwoLineBtn top="○" bottom="여성" onClick={() => addNode("여성")} />
          <TwoLineBtn top="◇" bottom="논바이너리" onClick={() => addNode("논바이너리")} />
          <button onClick={() => addNode("레즈비언")}
            className="flex flex-col items-center justify-center px-1 py-1 rounded border text-[9px] font-medium border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2] hover:border-[#3a6a4a] leading-tight gap-0.5">
            <svg width="20" height="20" viewBox="0 0 20 20">
              <circle cx="10" cy="10" r="8" fill="white" stroke="#374151" strokeWidth="1.8"/>
              <polygon points="10,16 4,6.5 16,6.5" fill="none" stroke="#374151" strokeWidth="1.6"/>
            </svg>
            <span>레즈비언</span>
          </button>
          <button onClick={() => addNode("게이")}
            className="flex flex-col items-center justify-center px-1 py-1 rounded border text-[9px] font-medium border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2] hover:border-[#3a6a4a] leading-tight gap-0.5">
            <svg width="20" height="20" viewBox="0 0 20 20">
              <rect x="1" y="1" width="18" height="18" rx="1" fill="white" stroke="#374151" strokeWidth="1.8"/>
              <polygon points="10,16 4,7 16,7" fill="none" stroke="#374151" strokeWidth="1.6"/>
            </svg>
            <span>게이</span>
          </button>
          <TwoLineBtn top="사망" bottom="토글" onClick={toggleDead}
            disabled={!Array.from(selected).some(id => nodes.some(n => n.id === id))} />
          <TwoLineBtn top="내담자" bottom="토글" onClick={toggleClient}
            disabled={!Array.from(selected).some(id => nodes.some(n => n.id === id))}
            active={Array.from(selected).some(id => nodes.find(n => n.id === id)?.client)} />
        </div>

        <div className="h-6 w-px bg-gray-200" />

          <div className="h-6 w-px bg-gray-200" />

        {/* 선 카테고리 */}
        <div data-tour="geo-lines" className="flex items-center gap-1 shrink-0 flex-wrap">
        {lineCategories.map(cat => (
          <div key={cat.label} className="flex items-center gap-1 shrink-0">
            <span className="text-[8px] text-gray-400 font-bold mr-0.5 shrink-0 leading-tight text-center whitespace-pre-line">{cat.label}</span>
            {cat.types.map(t => (
              <TwoLineBtn key={t} preview={t} bottom={t} onClick={() => setLineType(t)} active={lineType === t} bw={bw} />
            ))}
            <div className="h-6 w-px bg-gray-200 mx-0.5" />
          </div>
        ))}
        </div>{/* geo-lines 닫기 */}

          <div className="h-6 w-px bg-gray-200" />
        </div>

        {/* ── 2행 ── */}
        <div className="flex items-center gap-1 py-1" style={{ flexShrink: 0, minWidth: "max-content" }}>

          {/* 자녀 연결선 종류 */}
                  <div className="flex items-center gap-1 shrink-0" data-tour="geo-child-line">
                    <span className="text-[8px] text-gray-400 font-bold leading-tight text-center">자녀</span>
                    {(["일반","위탁","입양"] as const).map(t => (
                      <button key={t} onClick={() => setChildLineType(t)}
                        className={`flex flex-col items-center justify-center px-1 py-1 rounded border text-[9px] font-medium transition-colors leading-tight gap-0.5
                          ${childLineType === t ? "bg-[#e8f4e8] border-[#3a6a4a] text-[#2d7a3a]" : "border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2]"}`}>
                        <svg width="24" height="20" viewBox="0 0 24 20">
                          {t === "일반" && <line x1="12" y1="2" x2="12" y2="18" stroke="#374151" strokeWidth="2"/>}
                          {t === "위탁" && <line x1="12" y1="2" x2="12" y2="18" stroke="#374151" strokeWidth="2" strokeDasharray="4 3"/>}
                          {t === "입양" && <g>
                            <line x1="8" y1="2" x2="8" y2="18" stroke="#374151" strokeWidth="2"/>
                            <line x1="16" y1="2" x2="16" y2="18" stroke="#374151" strokeWidth="2" strokeDasharray="4 3"/>
                          </g>}
                        </svg>
                        <span>{t}</span>
                      </button>
                    ))}
                  </div>

          <div className="h-6 w-px bg-gray-200" />

          {/* 쌍둥이 */}
                  {(() => {
                    const selectedChildIds = Array.from(selected).filter(id => nodes.some(n => n.id === id));
                    const twinDisabled = selectedChildIds.length < 2;
                    return (
                  <div className="flex items-center gap-1 shrink-0" data-tour="geo-twins">
                    <span className="text-[8px] text-gray-400 font-bold leading-tight text-center">쌍<br/>둥<br/>이</span>
                    {([
                      { label: "쌍둥이", identical: false },
                      { label: "일란성", identical: true },
                    ]).map(({ label, identical }) => {
                      const disabled = twinDisabled;
                      return (
                        <button key={label}
                          disabled={disabled}
                          onClick={() => {
                            const selChildIds2 = Array.from(selected).filter(id => nodes.some(n => n.id === id));
                            if (selChildIds2.length < 2) return;
                            // 가장 가까운 결혼선 자동 탐색
                            const avgX = selChildIds2.reduce((s, id) => s + (nodes.find(n => n.id === id)?.x ?? 0), 0) / selChildIds2.length;
                            const avgY = selChildIds2.reduce((s, id) => s + (nodes.find(n => n.id === id)?.y ?? 0), 0) / selChildIds2.length;
                            let pm = marriages.find(m => selChildIds2.filter(id => m.childIds.includes(id)).length >= 2);
                            if (!pm) {
                              // 가장 가까운 결혼선에 자동 연결
                              let minDist = Infinity;
                              marriages.forEach(m => {
                                const ml = lines.find(l => l.id === m.id); if (!ml) return;
                                const p1 = getEndpoint(ml.from, nodes, lines), p2 = getEndpoint(ml.to, nodes, lines);
                                const midX = (p1.x + p2.x) / 2, midY = (p1.y + p2.y) / 2;
                                const dist = Math.hypot(avgX - midX, avgY - midY);
                                if (dist < minDist) { minDist = dist; pm = m; }
                              });
                              if (!pm) return;
                              // 자녀로 등록
                              setMarriages(prev => prev.map(m => m.id === pm!.id ? {
                                ...m,
                                childIds: [...new Set([...m.childIds, ...selChildIds2])],
                                childLineTypes: { ...m.childLineTypes, ...Object.fromEntries(selChildIds2.map(id => [id, "일반" as ChildLineType])) },
                              } : m));
                            }
                            saveHistory();
                            if (identical) {
                              setNodes(p => p.map(n => selChildIds2.includes(n.id) ? { ...n, identical: true } : n));
                            } else {
                              setNodes(p => p.map(n => selChildIds2.includes(n.id) ? { ...n, identical: false } : n));
                            }
                            setMarriages(p => p.map(m => m.id === pm!.id ? {
                              ...m,
                              twinGroups: [...(m.twinGroups || []).filter(g => !g.some(id => selChildIds2.includes(id))), selChildIds2],
                              twinDropOffsets: [...(m.twinDropOffsets || []).map((v, i) => v), 40],
                            } : m));
                          }}
                          className={`flex flex-col items-center justify-center px-1 py-1 rounded border text-[9px] font-medium transition-colors leading-tight gap-0.5
                            border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2] hover:border-[#3a6a4a]
                            ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}>
                          <svg width="32" height="22" viewBox="0 0 32 22">
                            <line x1="16" y1="2" x2="9" y2="13" stroke="#374151" strokeWidth="1.5"/>
                            <line x1="16" y1="2" x2="23" y2="13" stroke="#374151" strokeWidth="1.5"/>
                            {/* 일란성: 두 원 중심 사이 가로선 */}
                            {identical && <line x1="9" y1="17" x2="23" y2="17" stroke="#374151" strokeWidth="1.5"/>}
                            <circle cx="9" cy="17" r="4" fill="white" stroke="#374151" strokeWidth="1.3"/>
                            <circle cx="23" cy="17" r="4" fill="white" stroke="#374151" strokeWidth="1.3"/>
                          </svg>
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>
                    );
                  })()}

          <div className="h-6 w-px bg-gray-200" />

          {/* 특수 자녀 도형 */}
                  <div className="flex items-center gap-1 shrink-0" data-tour="geo-child-types">
                    <span className="text-[8px] text-gray-400 font-bold leading-tight text-center">자녀<br/>유형</span>
                    {([
                      { g: "임신" as const, icon: <polygon points="10,3 17,16 3,16" fill="white" stroke="#374151" strokeWidth="1.5"/> },
                      { g: "사산아" as const, icon: <g><rect x="5" y="5" width="10" height="10" fill="white" stroke="#374151" strokeWidth="1.5"/><line x1="7" y1="7" x2="13" y2="13" stroke="#374151" strokeWidth="1.5"/><line x1="13" y1="7" x2="7" y2="13" stroke="#374151" strokeWidth="1.5"/></g> },
                      { g: "자연유산" as const, icon: <g><polygon points="10,3 17,16 3,16" fill="white" stroke="#374151" strokeWidth="1.5"/><line x1="6" y1="8" x2="14" y2="14" stroke="#374151" strokeWidth="1.5"/><line x1="14" y1="8" x2="6" y2="14" stroke="#374151" strokeWidth="1.5"/></g> },
                      { g: "인공유산" as const, icon: <g><polygon points="10,3 17,16 3,16" fill="white" stroke="#374151" strokeWidth="1.5"/><line x1="6" y1="8" x2="14" y2="14" stroke="#374151" strokeWidth="1.5"/><line x1="14" y1="8" x2="6" y2="14" stroke="#374151" strokeWidth="1.5"/><line x1="3" y1="14" x2="17" y2="14" stroke="#374151" strokeWidth="1.5"/></g> },
                    ]).map(({ g, icon }) => (
                      <button key={g} onClick={() => addNode(g)}
                        className="flex flex-col items-center justify-center px-1 py-1 rounded border text-[9px] font-medium border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2] hover:border-[#3a6a4a] leading-tight gap-0.5">
                        <svg width="20" height="20" viewBox="0 0 20 20">{icon}</svg>
                        <span>{g}</span>
                      </button>
                    ))}
                  </div>

          <div className="h-6 w-px bg-gray-200" />

          <div className="flex items-center gap-1 shrink-0" data-tour="geo-substance">
          <span className="text-[8px] text-gray-400 font-bold shrink-0 leading-tight text-center">약물<br/>정신<br/>신체</span>
                  <div className="flex items-center gap-1 shrink-0">
                    {(["약물남용", "정신신체문제", "약물정신신체", "약물남용의심", "약물남용회복"] as SubstanceType[]).map(type => {
                      const selNodes = Array.from(selected).map(id => nodes.find(n => n.id === id)).filter(Boolean) as GNode[];
                      const isActive = selNodes.length > 0 && selNodes.every(n => n.substance === type);
                      const isDisabled = selNodes.length === 0;
                      const label = type === "약물남용" ? "약물남용" : type === "정신신체문제" ? "정신신체" : type === "약물정신신체" ? "약물+정신" : type === "약물남용의심" ? "의심" : "회복";
                      return (
                        <button key={type} onClick={() => toggleSubstance(type)} disabled={isDisabled}
                          title={type ?? ""}
                          className={`flex flex-col items-center justify-center px-1 py-1 rounded border text-[9px] font-medium transition-colors leading-tight min-w-[36px] gap-0.5
                            ${isActive ? "bg-[#e8f4e8] border-[#3a6a4a] text-[#2d7a3a]" : "border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2] hover:border-[#3a6a4a]"}
                            ${isDisabled ? "opacity-40 cursor-not-allowed" : ""}`}>
                          <svg width="22" height="22" viewBox="0 0 22 22">
                            <rect x="1" y="1" width="20" height="20" rx="1" fill="white" stroke="#888" strokeWidth="1.2" />
                            <circle cx="11" cy="11" r="9" fill="none" stroke="#888" strokeWidth="1" />
                            <polygon points="11,1 21,11 11,21 1,11" fill="none" stroke="#888" strokeWidth="0.8" />
                            {type === "약물남용" && <rect x="2" y="11" width="18" height="9" fill="#222" />}
                            {type === "정신신체문제" && <rect x="2" y="2" width="9" height="18" fill="#222" />}
                            {type === "약물정신신체" && <><rect x="2" y="2" width="18" height="18" fill="#222" /><rect x="11" y="2" width="9" height="9" fill="white" /></>}
                            {type === "약물남용의심" && <rect x="2" y="11" width="18" height="9" fill="#999" />}
                            {type === "약물남용회복" && <>
                              <rect x="11" y="11" width="9" height="9" fill="#999" />
                              <rect x="2" y="11" width="9" height="9" fill="#222" />
                            </>}
                          </svg>
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>
          </div>{/* geo-substance 닫기 */}

                  <div className="h-4 w-px bg-gray-200 mx-1" />

          <div className="h-6 w-px bg-gray-200" />

          {/* 텍스트 — 2행 약물 오른쪽 */}
                  <div className="flex items-center gap-1 shrink-0" data-tour="geo-textbox">
                    <button onClick={() => { setTextBoxMode(v => !v); setSelected(new Set()); }}
                      className={`flex flex-col items-center justify-center px-1.5 py-1 rounded border text-[10px] font-medium transition-colors leading-tight min-w-[36px] gap-0.5
                        ${textBoxMode ? "bg-[#e8f4e8] border-[#3a6a4a] text-[#2d7a3a]" : "border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2] hover:border-[#3a6a4a]"}`}>
                      <span className="text-[13px] font-bold leading-none">T</span>
                      <span className="text-[9px]">텍스트</span>
                    </button>
                    {[["#222222","검정"],["#dc2626","빨강"],["#2563eb","파랑"]].map(([col, label]) => (
                      <button key={col} onClick={() => setTextBoxColor(col)} title={label}
                        className={`w-5 h-5 rounded-full border-2 transition-all ${textBoxColor === col ? "border-[#3a6a4a] scale-110" : "border-gray-300"}`}
                        style={{ background: col }} />
                    ))}
                    {Array.from(selected).some(id => textBoxes.some(t => t.id === id)) && (
                      <div className="flex items-center gap-0.5 ml-1">
                        <button onClick={() => { saveHistory(); setTextBoxes(p => p.map(t => selected.has(t.id) ? { ...t, fontSize: Math.max(8, t.fontSize - 2) } : t)); }}
                          className="w-5 h-5 rounded border border-gray-200 bg-gray-50 text-xs flex items-center justify-center hover:bg-gray-100">−</button>
                        <span className="text-[10px] text-gray-500 w-6 text-center">{textBoxes.find(t => selected.has(t.id))?.fontSize ?? 14}</span>
                        <button onClick={() => { saveHistory(); setTextBoxes(p => p.map(t => selected.has(t.id) ? { ...t, fontSize: Math.min(48, t.fontSize + 2) } : t)); }}
                          className="w-5 h-5 rounded border border-gray-200 bg-gray-50 text-xs flex items-center justify-center hover:bg-gray-100">+</button>
                      </div>
                    )}
                  </div>

          <div className="h-6 w-px bg-gray-200" />

          {/* 기능 */}
                  <div className="flex items-center gap-1 shrink-0" data-tour="geo-actions">
                    <TwoLineBtn top="자녀" bottom="추가"
                      onClick={() => {
                        const selLine = lines.find(l => selected.has(l.id) && marriages.some(m => m.id === l.id));
                        if (selLine) { setConnectingFrom(selLine.id); setConnectingMode("child"); }
                      }}
                      disabled={!lines.some(l => selected.has(l.id) && marriages.some(m => m.id === l.id))}
                    />
                    <button onClick={undo} disabled={history.length === 0}
                      className={`flex flex-col items-center justify-center px-1.5 py-1 rounded border text-[10px] font-medium transition-colors leading-tight min-w-[36px] gap-0.5
                        border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2] hover:border-[#3a6a4a]
                        ${history.length === 0 ? "opacity-40 cursor-not-allowed" : ""}`}>
                      <span className="text-[13px] leading-none">↩</span>
                      <span className="text-[10px]">뒤로</span>
                    </button>
                  </div>

          <div className="ml-auto flex items-center gap-1.5" data-tour="geo-save">
          {!legendVisible && (
            <button onClick={() => setLegendVisible(true)}
              className="flex flex-col items-center justify-center px-1.5 py-1 rounded border text-[10px] font-medium transition-colors leading-tight min-w-[36px] gap-0.5 border-gray-300 bg-gray-100 text-gray-500 hover:bg-[#f0f7f2] hover:border-[#3a6a4a]">
              <span className="text-[10px]">범례</span>
              <span className="text-[10px]">표시</span>
            </button>
          )}
          <div className="flex items-center gap-1">
          <button onClick={() => setBw(v => !v)}
          className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${bw ? "bg-gray-700" : "bg-[#3a6a4a]"}`}>
          <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform shadow ${bw ? "translate-x-3" : "translate-x-0.5"}`} />
          </button>
          <span className="text-[10px] text-gray-500">{bw ? "흑백" : "컬러"}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <button onClick={() => setZoom(z => Math.max(0.2, +(z / 1.25).toFixed(3)))}
              className="w-6 h-8 flex items-center justify-center rounded border border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2] hover:border-[#3a6a4a] text-base font-bold leading-none"
              title="축소">−</button>
            <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
              className="text-[9px] text-gray-500 min-w-[30px] text-center hover:text-[#3a6a4a] hover:underline"
              title="100% 리셋">{Math.round(zoom * 100)}%</button>
            <button onClick={() => setZoom(z => Math.min(4, +(z * 1.25).toFixed(3)))}
              className="w-6 h-8 flex items-center justify-center rounded border border-gray-200 bg-gray-50 text-gray-700 hover:bg-[#f0f7f2] hover:border-[#3a6a4a] text-base font-bold leading-none"
              title="확대">+</button>
          </div>
          {/* 저장 드롭다운 */}
          <div className="relative" ref={saveMenuRef}>
            <TwoLineBtn top="💾" bottom="저장" onClick={() => setShowSaveMenu(v => !v)} active={showSaveMenu} />
            {showSaveMenu && (
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden" style={{ minWidth: 168 }}>
                <button
                  onClick={saveImg}
                  className="w-full px-3 py-2 text-left text-xs hover:bg-gray-50 flex items-center gap-2 border-b border-gray-100"
                >
                  <span className="text-base">🖼️</span>
                  <div>
                    <div className="font-medium text-gray-700">SVG로 저장</div>
                    <div className="text-[10px] text-gray-400">이미지 파일 (수정 불가)</div>
                  </div>
                </button>
                <button
                  onClick={saveJson}
                  className="w-full px-3 py-2 text-left text-xs hover:bg-[#f0f7f2] flex items-center gap-2"
                >
                  <span className="text-base">📋</span>
                  <div>
                    <div className="font-medium text-[#3a6a4a]">JSON으로 저장</div>
                    <div className="text-[10px] text-[#3a6a4a]">✏️ 불러와서 수정 가능</div>
                  </div>
                </button>
              </div>
            )}
          </div>
          {/* JSON 불러오기 */}
          <input type="file" accept=".json" ref={jsonInputRef} style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) loadJson(f); e.target.value = ""; }} />
          <TwoLineBtn top="📂" bottom="열기" onClick={() => jsonInputRef.current?.click()} />
          <TwoLineBtn top="삭" bottom="제" onClick={doDelete} disabled={selected.size === 0} danger />
          </div>
        </div>
      </div>


      {/* ── 캔버스 + 사이드 패널 ── */}
      <div className="flex flex-1 overflow-hidden">
      <div ref={wrapRef} data-tour="geo-canvas"
        className="flex-1 relative overflow-hidden"
        style={{ background: bw ? "#fff" : "#fafafa", backgroundImage: bw ? "none" : "radial-gradient(circle, #d1d5db 1px, transparent 1px)", backgroundSize: "24px 24px" }}
        onMouseDownCapture={(e) => {
          if (spaceRef.current) {
            e.stopPropagation();
            e.preventDefault();
            const startX = e.clientX, startY = e.clientY;
            const panX = pan.x, panY = pan.y;
            const onMove = (ev: MouseEvent) => {
              setPan({ x: panX + (ev.clientX - startX), y: panY + (ev.clientY - startY) });
            };
            const onUp = () => {
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          }
        }}
        onMouseDown={onCanvasDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>

        {connectingFrom && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-amber-500 text-white text-xs px-4 py-1.5 rounded-full shadow font-medium pointer-events-none">
            {connectingMode === "child" ? "자녀 노드 클릭 — Esc 취소" : "연결할 도형 클릭 — Esc 취소"}
          </div>
        )}

        <svg ref={svgRef} width="100%" height="100%"
          viewBox={`0 0 ${canvasW} ${canvasH}`}
          style={{ cursor: spaceDown ? "grab" : connectingFrom ? "crosshair" : "default" }}>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>

          {marriages.map(m => renderMarriage(m))}

          {lines.map(l => (
            <g key={l.id} onClick={e => handleLineClick(e, l.id)}
              onContextMenu={e => handleLineRightClick(e, l.id)}
              style={{ cursor: "pointer" }} pointerEvents="all">
              {renderLine(l)}
            </g>
          ))}

          {nodes.map(n => {
            const isSel = selected.has(n.id), isConn = connectingFrom === n.id && connectingMode === "node";
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: "grab" }}
                onMouseDown={e => onNodeDown(e, n.id)}
                onClick={e => handleNodeClick(e, n.id)}
                onDoubleClick={e => startEdit(e, n.id, "label")}
                onContextMenu={e => handleNodeRightClick(e, n.id)}>
                {renderShape(n, isSel, isConn)}
                {/* 나이 — 특수자녀(임신/사산아/자연유산/인공유산)는 나이란 없음 */}
                {!["임신","사산아","자연유산","인공유산"].includes(n.gender) && (
                  editId === n.id && editField === "age" ? (
                    <foreignObject x={4} y={4} width={NS - 8} height={20}>
                      <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
                        onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditId(null); }}
                        style={{ width: "100%", fontSize: 10, textAlign: "center", border: "1px solid #3a6a4a", borderRadius: 2, padding: "1px 2px", outline: "none", background: "rgba(255,255,255,0.9)" }} />
                    </foreignObject>
                  ) : (
                    <text x={NS / 2} y={n.gender === "논바이너리" ? (n.client ? NS / 2 + 4 : 22) : (n.client ? NS / 2 + 4 : 16)} textAnchor="middle" fontSize={10}
                      fill={n.age ? "#222" : "#bbb"}
                      stroke={n.substance ? "white" : "none"} strokeWidth={n.substance ? 2.5 : 0} paintOrder="stroke"
                      fontFamily="'Malgun Gothic', sans-serif"
                      style={{ cursor: "text" }}
                      onClick={e => { e.stopPropagation(); startEdit(e, n.id, "age"); }}>
                      {n.age || "나이"}
                    </text>
                  )
                )}
                {/* 이름 (도형 아래 — 특수자녀는 도형이 작아서 가까이) */}
                {(() => {
                  const isSpecial = ["임신","사산아","자연유산","인공유산"].includes(n.gender);
                  const labelY = isSpecial ? NS/2 + (n.gender === "자연유산" || n.gender === "인공유산" ? 20 : 28) : NS + 15;
                  const foY = isSpecial ? labelY - 12 : NS + 2;
                  return editId === n.id && editField === "label" ? (
                    <foreignObject x={-20} y={foY} width={NS + 40} height={26}>
                      <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
                        onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditId(null); }}
                        style={{ width: "100%", fontSize: 11, textAlign: "center", border: "1px solid #3a6a4a", borderRadius: 3, padding: "1px 3px", outline: "none" }} />
                    </foreignObject>
                  ) : (
                    <text x={NS / 2} y={labelY} textAnchor="middle" fontSize={11} fontWeight="500"
                      fill={n.label ? "#222" : "#ccc"} fontFamily="'Malgun Gothic', sans-serif">
                      {n.label || "더블클릭"}
                    </text>
                  );
                })()}
              </g>
            );
          })}

          {/* 범례 */}
          {legendVisible && totalItems > 0 && (() => {
            const fs = 10 * legendFontScale;
            const rowH = 22 * legendFontScale;
            const SEC_H = 17 * legendFontScale;   // 섹션 헤더 높이
            const TITLE_H = 20 * legendFontScale;  // "범 례" 타이틀 높이
            const ICON_W = 42 * legendFontScale;   // 아이콘+간격 영역 너비
            const bxW = legendBoxW;
            const isLegSel = legendSelected;

            // ── 열 수 결정: 박스 너비 240px(scale 기준) 이상이면 2열
            const cols = bxW >= 240 ? 2 : 1;
            const colW = (bxW - 4) / cols;         // 열 너비 (좌우 여백 4px 제외)

            // ── 레이블 렌더링 헬퍼 (더블클릭으로 편집)
            const renderLegendLabel = (key: string, defaultLabel: string, ix: number, iy: number, maxW: number) => {
              const label = legendLabelOverrides[key] ?? defaultLabel;
              if (editingLegendKey === key) {
                return (
                  <foreignObject x={ix} y={iy - fs} width={maxW - ix - 2} height={rowH * 2}>
                    <textarea
                      style={{ width: "100%", height: "100%", fontSize: fs, fontFamily: "'Malgun Gothic', sans-serif", border: "1px solid #3a6a4a", borderRadius: 2, resize: "none", outline: "none", padding: "1px 2px", background: "rgba(255,255,255,0.95)", color: "#374151", lineHeight: 1.3 }}
                      autoFocus defaultValue={label}
                      onBlur={e => { setLegendLabelOverrides(p => ({ ...p, [key]: e.target.value })); setEditingLegendKey(null); }}
                      onKeyDown={e => { if (e.key === "Escape") setEditingLegendKey(null); e.stopPropagation(); }}
                      onClick={e => e.stopPropagation()} />
                  </foreignObject>
                );
              }
              const labelLines = label.split("\n");
              return (
                <text x={ix} y={iy} fontSize={fs} fill="#374151" fontFamily="'Malgun Gothic', sans-serif"
                  style={{ cursor: "text" }}
                  onDoubleClick={e => { e.stopPropagation(); setEditingLegendKey(key); }}>
                  {labelLines.map((ln, li) => <tspan key={li} x={ix} dy={li === 0 ? 0 : fs * 1.2}>{ln}</tspan>)}
                </text>
              );
            };

            // ── 섹션별 항목 정의 (레이아웃 사전 계산용)
            type SectionDef = { id: string; label: string; count: number };
            const sectionDefs: SectionDef[] = [];
            if (usedNodeEntries.length > 0) sectionDefs.push({ id: "node", label: "인물", count: usedNodeEntries.length });
            if (usedLineTypes.length > 0) sectionDefs.push({ id: "line", label: "관계/정서선", count: usedLineTypes.length });
            if (usedChildLineTypes.length > 0) sectionDefs.push({ id: "child", label: "자녀 연결선", count: usedChildLineTypes.length });
            if (twinEntries.length > 0) sectionDefs.push({ id: "twin", label: "쌍둥이", count: twinEntries.length });

            // ── 섹션별 시작 Y 위치 계산
            // 타이틀("범 례"): TITLE_H, 그 다음부터 섹션들
            const sectionStartYs: Record<string, number> = {};
            let curY = TITLE_H + 4;
            for (const sec of sectionDefs) {
              sectionStartYs[sec.id] = curY + SEC_H; // 섹션 헤더 아래에서 아이템 시작
              const rows = Math.ceil(sec.count / cols);
              curY += SEC_H + rows * rowH + 4;
            }
            const contentH = curY + 6;
            const bxH = legendBoxH > 0 ? legendBoxH : contentH;

            // ── 항목별 x/y 계산 헬퍼
            const itemPos = (secId: string, idx: number) => {
              const startY = sectionStartYs[secId];
              const col = idx % cols;
              const row = Math.floor(idx / cols);
              return { x: col * colW, y: startY + row * rowH };
            };

            return (
              <g transform={`translate(${lx},${ly})`}>
                {/* 박스 */}
                <rect x={-8} y={-8} width={bxW} height={bxH}
                  fill="white" stroke={isLegSel ? "#3a6a4a" : "#e5e7eb"} strokeWidth={isLegSel ? 2 : 1} rx={6}
                  style={{ filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.12))", cursor: "move" }}
                  onMouseDown={e => {
                    e.stopPropagation(); setLegendSelected(true);
                    const r = wrapRef.current!.getBoundingClientRect();
                    legendDragRef.current = { type: "move", ox: e.clientX - r.left - lx, oy: e.clientY - r.top - ly };
                  }} />

                {/* X 버튼 (선택 시) */}
                {isLegSel && (
                  <g style={{ cursor: "pointer" }} onClick={e => { e.stopPropagation(); setLegendVisible(false); setLegendSelected(false); }}>
                    <circle cx={bxW - 14} cy={-14} r={9} fill="#ef4444" />
                    <line x1={bxW-18} y1={-18} x2={bxW-10} y2={-10} stroke="white" strokeWidth={1.8} />
                    <line x1={bxW-10} y1={-18} x2={bxW-18} y2={-10} stroke="white" strokeWidth={1.8} />
                  </g>
                )}

                {/* 타이틀 */}
                <text x={0} y={13 * legendFontScale} fontSize={fs + 1} fontWeight="700" fill="#6b7280" fontFamily="'Malgun Gothic', sans-serif">범 례</text>

                {/* ── 인물 섹션 ── */}
                {usedNodeEntries.length > 0 && (
                  <text x={0} y={sectionStartYs["node"] - SEC_H + fs} fontSize={fs - 1} fill="#9ca3af" fontFamily="'Malgun Gothic', sans-serif">인물</text>
                )}
                {usedNodeEntries.map((e, i) => {
                  const { x: ix, y: iy } = itemPos("node", i);
                  const sc = legendFontScale; const NS2 = 14 * sc; const half2 = NS2 / 2; const s = e.substance;
                  const key = `node_${e.key}`;
                  const SW = 1.5; const r = half2 - 1; const gap2 = 2 * sc;

                  // ── 사각형(남성/게이) 약물 채움 헬퍼 ──
                  const rectSub = () => {
                    if (s === "약물남용")    return <rect key="sub" x={1} y={half2+1} width={NS2-2} height={half2-1} fill="#222" />;
                    if (s === "정신신체문제") return <rect key="sub" x={1} y={1} width={half2-1} height={NS2-2} fill="#222" />;
                    if (s === "약물정신신체") return <g key="sub"><rect x={1} y={1} width={NS2-2} height={NS2-2} fill="#222" /><rect x={half2} y={1} width={half2-1} height={half2-1} fill="white" /></g>;
                    if (s === "약물남용의심") return <rect key="sub" x={1} y={half2+1} width={NS2-2} height={half2-1} fill="#999" />;
                    if (s === "약물남용회복") return <g key="sub"><rect x={half2} y={half2+1} width={half2-1} height={half2-1} fill="#999" /><rect x={1} y={half2+1} width={half2-1} height={half2-1} fill="#222" /></g>;
                    return null;
                  };
                  // ── 원(여성/레즈비언) 약물 채움 헬퍼 ──
                  const circSub = () => {
                    if (s === "약물남용")    return <path key="sub" d={`M ${half2} ${half2+1} m -${r} 0 a ${r} ${r} 0 0 0 ${r*2} 0 Z`} fill="#222" />;
                    if (s === "정신신체문제") return <path key="sub" d={`M ${half2} 1 a ${r} ${r} 0 0 0 0 ${r*2} Z`} fill="#222" />;
                    if (s === "약물정신신체") return <path key="sub" d={`M ${half2} ${half2+1} L ${NS2-1} ${half2+1} A ${r} ${r} 0 1 1 ${half2} 1 Z`} fill="#222" />;
                    if (s === "약물남용의심") return <path key="sub" d={`M ${half2} ${half2+1} m -${r} 0 a ${r} ${r} 0 0 0 ${r*2} 0 Z`} fill="#999" />;
                    if (s === "약물남용회복") return <g key="sub"><path d={`M ${half2} ${half2+1} L ${NS2-1} ${half2+1} A ${r} ${r} 0 0 1 ${half2} ${NS2} Z`} fill="#999" /><path d={`M ${half2} ${half2+1} L 1 ${half2+1} A ${r} ${r} 0 0 0 ${half2} ${NS2} Z`} fill="#222" /></g>;
                    return null;
                  };
                  // ── 마름모(논바이너리) 약물 채움 헬퍼 ──
                  const diamSub = () => {
                    if (s === "약물남용")    return <path key="sub" d={`M 0,${half2+1} L ${half2},${NS2+1} L ${NS2},${half2+1} Z`} fill="#222" />;
                    if (s === "정신신체문제") return <path key="sub" d={`M 0,${half2+1} L ${half2},1 L ${half2},${NS2+1} Z`} fill="#222" />;
                    if (s === "약물정신신체") return <g key="sub"><path d={`M ${half2},1 L ${NS2},${half2+1} L ${half2},${NS2+1} L 0,${half2+1} Z`} fill="#222" /><path d={`M ${half2},1 L ${NS2},${half2+1} L ${half2},${half2+1} Z`} fill="white" /></g>;
                    if (s === "약물남용의심") return <path key="sub" d={`M 0,${half2+1} L ${half2},${NS2+1} L ${NS2},${half2+1} Z`} fill="#999" />;
                    if (s === "약물남용회복") return <g key="sub"><path d={`M ${half2},${half2+1} L ${NS2},${half2+1} L ${half2},${NS2+1} Z`} fill="#999" /><path d={`M ${half2},${half2+1} L 0,${half2+1} L ${half2},${NS2+1} Z`} fill="#222" /></g>;
                    return null;
                  };

                  return (
                    <g key={e.key} transform={`translate(${ix},${iy})`}>
                      {/* ── 남성: 사각형 → 약물채움 → 내담자 이중선 ── */}
                      {e.gender === "남성" && <>
                        <rect x={0} y={1} width={NS2} height={NS2} fill="#fff" stroke="#222" strokeWidth={SW} />
                        {rectSub()}
                        {e.client && <rect x={gap2} y={gap2+1} width={NS2-gap2*2} height={NS2-gap2*2} fill="none" stroke="#222" strokeWidth={1} />}
                      </>}
                      {/* ── 여성: 원 → 약물채움 → 내담자 이중선 ── */}
                      {e.gender === "여성" && <>
                        <circle cx={half2} cy={half2+1} r={half2} fill="#fff" stroke="#222" strokeWidth={SW} />
                        {circSub()}
                        {e.client && <circle cx={half2} cy={half2+1} r={half2-gap2} fill="none" stroke="#222" strokeWidth={1} />}
                      </>}
                      {/* ── 논바이너리: 마름모 → 약물채움 → 내담자 이중선 ── */}
                      {e.gender === "논바이너리" && <>
                        <polygon points={`${half2},1 ${NS2},${half2+1} ${half2},${NS2+1} 0,${half2+1}`} fill="#fff" stroke="#222" strokeWidth={SW} />
                        {diamSub()}
                        {e.client && <polygon points={`${half2},${gap2+1} ${NS2-gap2},${half2+1} ${half2},${NS2-gap2+1} ${gap2},${half2+1}`} fill="none" stroke="#222" strokeWidth={1} />}
                      </>}
                      {/* ── 레즈비언: 원 → 약물채움 → 삼각형(마지막에!) → 내담자 이중선 ── */}
                      {e.gender === "레즈비언" && <>
                        <circle cx={half2} cy={half2+1} r={half2} fill="#fff" stroke="#222" strokeWidth={SW} />
                        {circSub()}
                        <polygon points={`${half2},${half2+NS2*0.42} ${half2-NS2*0.36},${half2-NS2*0.2+1} ${half2+NS2*0.36},${half2-NS2*0.2+1}`} fill="none" stroke="white" strokeWidth={SW+1} />
                        <polygon points={`${half2},${half2+NS2*0.42} ${half2-NS2*0.36},${half2-NS2*0.2+1} ${half2+NS2*0.36},${half2-NS2*0.2+1}`} fill="none" stroke="#222" strokeWidth={SW} />
                        {e.client && <circle cx={half2} cy={half2+1} r={half2-gap2} fill="none" stroke="#222" strokeWidth={1} />}
                      </>}
                      {/* ── 게이: 사각형 → 약물채움 → 삼각형(마지막에!) → 내담자 이중선 ── */}
                      {e.gender === "게이" && <>
                        <rect x={0} y={1} width={NS2} height={NS2} fill="#fff" stroke="#222" strokeWidth={SW} />
                        {rectSub()}
                        <polygon points={`${half2},${half2+NS2*0.4} ${half2-NS2*0.33},${half2-NS2*0.18+1} ${half2+NS2*0.33},${half2-NS2*0.18+1}`} fill="none" stroke="white" strokeWidth={SW+1} />
                        <polygon points={`${half2},${half2+NS2*0.4} ${half2-NS2*0.33},${half2-NS2*0.18+1} ${half2+NS2*0.33},${half2-NS2*0.18+1}`} fill="none" stroke="#222" strokeWidth={SW} />
                        {e.client && <rect x={gap2} y={gap2+1} width={NS2-gap2*2} height={NS2-gap2*2} fill="none" stroke="#222" strokeWidth={1} />}
                      </>}
                      {/* ── 특수 자녀 도형 ── */}
                      {e.gender === "임신" && <polygon points={`${half2},1 ${NS2},${NS2} 0,${NS2}`} fill="#fff" stroke="#222" strokeWidth={SW} />}
                      {e.gender === "사산아" && (() => { const sz2=NS2*0.5,ox2=(NS2-sz2)/2,oy2=(NS2-sz2)/2+1; return <><rect x={ox2} y={oy2} width={sz2} height={sz2} fill="#fff" stroke="#222" strokeWidth={SW} /><line x1={ox2+2} y1={oy2+2} x2={ox2+sz2-2} y2={oy2+sz2-2} stroke="#222" strokeWidth={SW} /><line x1={ox2+sz2-2} y1={oy2+2} x2={ox2+2} y2={oy2+sz2-2} stroke="#222" strokeWidth={SW} /></>; })()}
                      {e.gender === "자연유산" && <><polygon points={`${half2},1 ${NS2},${NS2+1} 0,${NS2+1}`} fill="#fff" stroke="#222" strokeWidth={SW} /><line x1={half2-3} y1={NS2*0.4} x2={half2+3} y2={NS2*0.75} stroke="#222" strokeWidth={SW} /><line x1={half2+3} y1={NS2*0.4} x2={half2-3} y2={NS2*0.75} stroke="#222" strokeWidth={SW} /></>}
                      {e.gender === "인공유산" && <><polygon points={`${half2},1 ${NS2},${NS2+1} 0,${NS2+1}`} fill="#fff" stroke="#222" strokeWidth={SW} /><line x1={half2-3} y1={NS2*0.4} x2={half2+3} y2={NS2*0.75} stroke="#222" strokeWidth={SW} /><line x1={half2+3} y1={NS2*0.4} x2={half2-3} y2={NS2*0.75} stroke="#222" strokeWidth={SW} /><line x1={1} y1={NS2} x2={NS2-1} y2={NS2} stroke="#222" strokeWidth={SW} /></>}
                      {/* ── 사망 X ── */}
                      {e.dead && <><line x1={2} y1={3} x2={NS2-2} y2={NS2-1} stroke="#222" strokeWidth={SW} /><line x1={NS2-2} y1={3} x2={2} y2={NS2-1} stroke="#222" strokeWidth={SW} /></>}
                      {renderLegendLabel(key, e.label, ICON_W, NS2 - 2, colW)}
                    </g>
                  );
                })}

                {/* ── 관계/정서선 섹션 ── */}
                {usedLineTypes.length > 0 && (
                  <text x={0} y={sectionStartYs["line"] - SEC_H + fs} fontSize={fs - 1} fill="#9ca3af" fontFamily="'Malgun Gothic', sans-serif">관계/정서선</text>
                )}
                {usedLineTypes.map((t, i) => {
                  const { x: ix, y: iy } = itemPos("line", i);
                  return (
                    <g key={t} transform={`translate(${ix},${iy})`}>
                      <g transform={`scale(${legendFontScale})`}><LinePreview type={t} size={36} bw={bw} /></g>
                      {renderLegendLabel(`line_${t}`, t, ICON_W, 13 * legendFontScale, colW)}
                    </g>
                  );
                })}

                {/* ── 자녀 연결선 섹션 ── */}
                {usedChildLineTypes.length > 0 && (
                  <text x={0} y={sectionStartYs["child"] - SEC_H + fs} fontSize={fs - 1} fill="#9ca3af" fontFamily="'Malgun Gothic', sans-serif">자녀 연결선</text>
                )}
                {usedChildLineTypes.map((t, i) => {
                  const { x: ix, y: iy } = itemPos("child", i);
                  const defaultLabel = t === "일반" ? "일반 자녀" : t === "위탁" ? "위탁 자녀" : "입양 자녀";
                  return (
                    <g key={`child_${t}`} transform={`translate(${ix},${iy})`}>
                      <g transform={`scale(${legendFontScale})`}>
                        {t === "일반" && <svg width={36} height={16}><line x1={2} y1={8} x2={34} y2={8} stroke="#374151" strokeWidth={2} /></svg>}
                        {t === "위탁" && <svg width={36} height={16}><line x1={2} y1={8} x2={34} y2={8} stroke="#374151" strokeWidth={2} strokeDasharray="6 4" /></svg>}
                        {t === "입양" && <svg width={36} height={16}><line x1={2} y1={5} x2={34} y2={5} stroke="#374151" strokeWidth={2} /><line x1={2} y1={11} x2={34} y2={11} stroke="#374151" strokeWidth={2} strokeDasharray="5 4" /></svg>}
                      </g>
                      {renderLegendLabel(`child_${t}`, defaultLabel, ICON_W, 13 * legendFontScale, colW)}
                    </g>
                  );
                })}

                {/* ── 쌍둥이 섹션 ── */}
                {twinEntries.length > 0 && (
                  <text x={0} y={sectionStartYs["twin"] - SEC_H + fs} fontSize={fs - 1} fill="#9ca3af" fontFamily="'Malgun Gothic', sans-serif">쌍둥이</text>
                )}
                {twinEntries.map((t, i) => {
                  const { x: ix, y: iy } = itemPos("twin", i);
                  const isIdentical = t === "일란성쌍둥이";
                  const sc = legendFontScale;
                  // 버튼 SVG 원본 viewBox: 32x22, scale 적용
                  const tw = 32 * sc, th = 22 * sc;
                  return (
                    <g key={t} transform={`translate(${ix},${iy - 4 * sc})`}>
                      <svg width={tw} height={th} viewBox="0 0 32 22" style={{ overflow: "visible" }}>
                        <line x1="16" y1="2" x2="9" y2="13" stroke="#374151" strokeWidth="1.5"/>
                        <line x1="16" y1="2" x2="23" y2="13" stroke="#374151" strokeWidth="1.5"/>
                        {isIdentical && <line x1="9" y1="17" x2="23" y2="17" stroke="#374151" strokeWidth="1.5"/>}
                        <circle cx="9" cy="17" r="4" fill="white" stroke="#374151" strokeWidth="1.3"/>
                        <circle cx="23" cy="17" r="4" fill="white" stroke="#374151" strokeWidth="1.3"/>
                      </svg>
                      {renderLegendLabel(`twin_${t}`, isIdentical ? "일란성 쌍둥이" : "이란성 쌍둥이", ICON_W, 13 * legendFontScale, colW)}
                    </g>
                  );
                })}

                {/* 박스 크기 조절 핸들 (우하단) */}
                {isLegSel && (
                  <rect x={bxW - 18} y={bxH - 18} width={14} height={14} fill="#3a6a4a" rx={2} style={{ cursor: "nw-resize" }}
                    onMouseDown={e => {
                      e.stopPropagation();
                      const r = wrapRef.current!.getBoundingClientRect();
                      legendDragRef.current = { type: "resizeBox", ox: e.clientX - r.left, oy: e.clientY - r.top, initW: legendBoxW, initH: legendBoxH > 0 ? legendBoxH : autoH };
                    }} />
                )}
                {/* 글씨 크기 조절 핸들 (좌하단) */}
                {isLegSel && (
                  <rect x={-8} y={bxH - 18} width={14} height={14} fill="#6b7280" rx={2} style={{ cursor: "ns-resize" }}
                    onMouseDown={e => {
                      e.stopPropagation();
                      const r = wrapRef.current!.getBoundingClientRect();
                      legendDragRef.current = { type: "resizeFont", ox: e.clientX - r.left, oy: e.clientY - r.top, initF: legendFontScale };
                    }} />
                )}
              </g>
            );
          })()}

          {/* ── 텍스트박스 ── */}
          {textBoxes.map(tb => {
            const isSel = selected.has(tb.id);
            const isEditing = editingTbId === tb.id;
            return (
              <g key={tb.id}>
                <rect x={tb.x} y={tb.y} width={tb.w} height={tb.h}
                  fill="transparent" stroke={isSel ? "#3a6a4a" : "transparent"} strokeWidth={1.5}
                  rx={3} style={{ cursor: "move" }}
                  onMouseDown={e => {
                    e.stopPropagation();
                    setSelected(new Set([tb.id]));
                    tbDragRef.current = { id: tb.id, type: "move", ox: e.clientX - wrapRef.current!.getBoundingClientRect().left - tb.x, oy: e.clientY - wrapRef.current!.getBoundingClientRect().top - tb.y };
                  }}
                  onDoubleClick={e => { e.stopPropagation(); setEditingTbId(tb.id); }}
                />
                {isEditing ? (
                  <foreignObject x={tb.x} y={tb.y} width={tb.w} height={tb.h}>
                    <textarea
                      style={{ width: "100%", height: "100%", border: "none", background: "transparent", resize: "none", fontSize: tb.fontSize, color: tb.color, fontFamily: "'Malgun Gothic', sans-serif", outline: "none", padding: "4px" }}
                      autoFocus
                      defaultValue={tb.text}
                      onBlur={e => { setTextBoxes(p => p.map(t => t.id === tb.id ? { ...t, text: e.target.value } : t)); setEditingTbId(null); }}
                      onKeyDown={e => { if (e.key === "Escape") setEditingTbId(null); e.stopPropagation(); }}
                      onClick={e => e.stopPropagation()}
                    />
                  </foreignObject>
                ) : (
                  <text x={tb.x + 4} y={tb.y + tb.fontSize + 2} fontSize={tb.fontSize} fill={tb.color} fontFamily="'Malgun Gothic', sans-serif" style={{ whiteSpace: "pre-wrap", pointerEvents: "none" }}>
                    {tb.text.split("\n").map((line, i) => (
                      <tspan key={i} x={tb.x + 4} dy={i === 0 ? 0 : tb.fontSize * 1.3}>{line}</tspan>
                    ))}
                  </text>
                )}
                {/* 리사이즈 핸들 */}
                {isSel && (
                  <rect x={tb.x + tb.w - 10} y={tb.y + tb.h - 10} width={10} height={10} fill="#3a6a4a" rx={2} style={{ cursor: "se-resize" }}
                    onMouseDown={e => {
                      e.stopPropagation();
                      tbDragRef.current = { id: tb.id, type: "resize", ox: e.clientX - wrapRef.current!.getBoundingClientRect().left, oy: e.clientY - wrapRef.current!.getBoundingClientRect().top, initW: tb.w, initH: tb.h };
                    }} />
                )}
              </g>
            );
          })}

          {rubber && (
            <rect x={rubber.x} y={rubber.y} width={rubber.w} height={rubber.h}
              fill="rgba(58,106,74,0.08)" stroke="#3a6a4a" strokeWidth={1} strokeDasharray="4 2" />
          )}
          </g>
        </svg>

        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-gray-300">
              <div className="text-4xl mb-2">□ ○ ◇</div>
              <div className="text-sm font-medium">상단에서 인물을 추가하세요</div>
            </div>
          </div>
        )}

        {/* ── 미니맵: 노드가 화면 밖으로 벗어났을 때만 표시 ── */}
        {nodes.length > 0 && nodes.some(n => {
          const sx = (n.x + NS/2) * zoom + pan.x;
          const sy = (n.y + NS/2) * zoom + pan.y;
          return sx < 0 || sx > canvasSize.w || sy < 0 || sy > canvasSize.h;
        }) && (() => {
          const MAP_W = 160, MAP_H = 110;
          let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
          nodes.forEach(n => {
            mnX = Math.min(mnX, n.x); mnY = Math.min(mnY, n.y);
            mxX = Math.max(mxX, n.x + NS); mxY = Math.max(mxY, n.y + NS + 20);
          });
          const pad = 40;
          mnX -= pad; mnY -= pad; mxX += pad; mxY += pad;
          const wW = mxX - mnX, wH = mxY - mnY;
          const sc = Math.min(MAP_W / wW, MAP_H / wH);
          const offX = (MAP_W - wW * sc) / 2, offY = (MAP_H - wH * sc) / 2;
          const toMap = (wx: number, wy: number) => ({ x: offX + (wx - mnX) * sc, y: offY + (wy - mnY) * sc });
          const vpX1 = -pan.x / zoom, vpY1 = -pan.y / zoom;
          const vpX2 = vpX1 + canvasSize.w / zoom, vpY2 = vpY1 + canvasSize.h / zoom;
          const vm1 = toMap(vpX1, vpY1), vm2 = toMap(vpX2, vpY2);
          const vrX = Math.max(0, vm1.x), vrY = Math.max(0, vm1.y);
          const vrW = Math.min(MAP_W, vm2.x) - vrX, vrH = Math.min(MAP_H, vm2.y) - vrY;
          return (
            <div style={{
              position: 'absolute', bottom: 12, right: 12, zIndex: 50,
              background: 'rgba(255,255,255,0.93)', border: '1px solid #e5e7eb',
              borderRadius: 8, boxShadow: '0 2px 10px rgba(0,0,0,0.13)',
              overflow: 'hidden', cursor: 'crosshair',
            }}
              onClick={e => {
                const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const mx = e.clientX - r.left - offX, my = e.clientY - r.top - offY;
                const wx = mx / sc + mnX, wy = my / sc + mnY;
                setPan({ x: canvasSize.w / 2 - wx * zoom, y: canvasSize.h / 2 - wy * zoom });
              }}>
              <svg width={MAP_W} height={MAP_H}>
                {lines.map(l => {
                  const p1 = getEndpoint(l.from, nodes, lines), p2 = getEndpoint(l.to, nodes, lines);
                  const m1 = toMap(p1.x, p1.y), m2 = toMap(p2.x, p2.y);
                  return <line key={l.id} x1={m1.x} y1={m1.y} x2={m2.x} y2={m2.y} stroke="#d1d5db" strokeWidth={1} />;
                })}
                {nodes.map(n => {
                  const { x, y } = toMap(n.x + NS/2, n.y + NS/2);
                  return <circle key={n.id} cx={x} cy={y} r={n.client ? 4 : 3} fill={n.client ? '#3a6a4a' : '#6b7280'} opacity={0.85} />;
                })}
                {vrW > 0 && vrH > 0 && (
                  <rect x={vrX} y={vrY} width={vrW} height={vrH}
                    fill="rgba(58,106,74,0.08)" stroke="#3a6a4a" strokeWidth={1.5} rx={2} />
                )}
              </svg>
              <div style={{ position: 'absolute', top: 3, left: 6, fontSize: 9, color: '#9ca3af', pointerEvents: 'none', fontFamily: 'Malgun Gothic, sans-serif' }}>전체보기 · 클릭이동</div>
            </div>
          );
        })()}
      </div>

      {/* ── 우측 사이드 패널 ── */}
      <div data-tour="geo-side-panel" style={{
        width: panelOpen ? 148 : 28, minWidth: panelOpen ? 148 : 28,
        background: '#fff', borderLeft: '1px solid #e5e7eb',
        display: 'flex', flexDirection: 'column',
        transition: 'width 0.18s, min-width 0.18s',
        overflow: 'hidden', flexShrink: 0,
      }}>
        <button
          onClick={() => setPanelOpen(v => !v)}
          title={panelOpen ? '패널 닫기' : '추가 선 열기'}
          style={{
            width: '100%', padding: '5px 0', background: 'none', border: 'none',
            borderBottom: '1px solid #e5e7eb', cursor: 'pointer',
            fontSize: 13, color: '#9ca3af',
            display: 'flex', alignItems: 'center',
            justifyContent: panelOpen ? 'flex-end' : 'center',
            paddingRight: panelOpen ? 8 : 0, flexShrink: 0,
          }}>
          {panelOpen ? '›' : '‹'}
        </button>
        {panelOpen && (
          <div style={{ padding: '8px 6px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <div style={{ fontSize: 9, color: '#9ca3af', fontWeight: 700, marginBottom: 4, paddingLeft: 2 }}>감정 관계선</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <TwoLineBtn preview={"무관심" as LineType} bottom="무관심" onClick={() => setLineType("무관심")} active={lineType === "무관심"} bw={bw} />
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: '#9ca3af', fontWeight: 700, marginBottom: 4, paddingLeft: 2 }}>학대·갈등</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {(["정서적학대", "방임", "통제"] as LineType[]).map(t => (
                  <TwoLineBtn key={t} preview={t} bottom={t} onClick={() => setLineType(t)} active={lineType === t} bw={bw} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      </div>

      {/* ── 하단 사용법 ── */}
      <div className="bg-white border-t border-gray-200 shrink-0">
        {/* 1행: 단축키 앞부분 + 저작권 */}
        <div className="px-5 pt-2.5 pb-1 flex items-center gap-3">
          <div className="flex items-center gap-3 text-[11px] text-gray-500 font-medium">
            <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">우클릭</kbd> 연결 시작</span>
            <span className="text-gray-300">|</span>
            <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">결혼/동거선 우클릭</kbd> 자녀 연결</span>
            <span className="text-gray-300">|</span>
            <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">내담자 토글</kbd> 이중도형 지정</span>
            <span className="text-gray-300">|</span>
            <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">더블클릭</kbd> 이름편집</span>
            <span className="text-gray-300">|</span>
            <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">나이클릭</kbd> 나이편집</span>
          </div>
          <span className="ml-auto font-semibold shrink-0 text-right leading-tight text-[11px] text-gray-500 whitespace-nowrap">
            © 2026. An In-song. Distributed for free.<br />(2026. 안인성. 무료 배포)
          </span>
        </div>
        {/* 2행: 단축키 나머지 */}
        <div className="px-5 pb-2.5 flex items-center gap-3 text-[11px] text-gray-500 font-medium">
          <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">Shift+클릭</kbd> 다중선택</span>
          <span className="text-gray-300">|</span>
          <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">드래그</kbd> 범위·이동</span>
          <span className="text-gray-300">|</span>
          <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">Del</kbd> 삭제</span>
          <span className="text-gray-300">|</span>
          <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">Ctrl+Z</kbd> 되돌리기</span>
        </div>
      </div>

    </div>
  );
}
