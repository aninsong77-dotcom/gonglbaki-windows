import { useEffect, useRef, useState, useCallback } from "react";

// ─── 타입 ─────────────────────────────────────────────────────
type Gender = "남성" | "여성" | "논바이너리";
type LineType =
  | "결혼" | "별거" | "이혼" | "동거"
  | "소원" | "친밀" | "밀착" | "단절"
  | "갈등" | "융합된갈등"
  | "신체적학대" | "성적학대";

interface GNode {
  id: string; gender: Gender; dead: boolean; client: boolean;
  label: string; age: string; x: number; y: number;
}
interface GLine { id: string; from: string; to: string; lineType: LineType; }
interface Marriage { id: string; childIds: string[]; }

const NS = 56, SNAP = 18, CHILD_DROP = 70;
const uid = () => Math.random().toString(36).slice(2, 9);

const FAMILY_TYPES: LineType[] = ["결혼", "별거", "이혼", "동거"];
const EMO_TYPES: LineType[] = ["소원", "친밀", "밀착", "단절"];
const CONFLICT_TYPES: LineType[] = ["갈등", "융합된갈등"];
const ABUSE_TYPES: LineType[] = ["신체적학대", "성적학대"];
const MARRIAGE_TYPES: LineType[] = ["결혼", "별거", "이혼", "동거"];

// 선 색상
function lineColor(lt: LineType, bw: boolean, sel: boolean): string {
  if (sel) return "#3a6a4a";
  if (bw) return "#222";
  if (["갈등", "융합된갈등", "신체적학대", "성적학대", "단절", "소원"].includes(lt)) return "#dc2626";
  if (lt === "친밀") return "#16a34a";
  if (lt === "밀착") return "#7c3aed";
  return "#222";
}

function nc(n: GNode) { return { x: n.x + NS / 2, y: n.y + NS / 2 }; }

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

function sharpZigzag(x1: number, y1: number, x2: number, y2: number) {
  const segs = 10, dx = (x2 - x1) / segs, dy = (y2 - y1) / segs;
  const nx = -dy * 0.4, ny = dx * 0.4;
  let d = `M ${x1} ${y1}`;
  for (let i = 1; i <= segs; i++) {
    const mx = x1 + dx * (i - 0.5) + (i % 2 === 0 ? nx : -nx);
    const my = y1 + dy * (i - 0.5) + (i % 2 === 0 ? ny : -ny);
    d += ` L ${mx} ${my} L ${x1 + dx * i} ${y1 + dy * i}`;
  }
  return d;
}

function waveZigzag(x1: number, y1: number, x2: number, y2: number) {
  const segs = 8, dx = (x2 - x1) / segs, dy = (y2 - y1) / segs;
  const nx = -dy * 0.35, ny = dx * 0.35;
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
  const [editId, setEditId] = useState<string | null>(null);
  const [editField, setEditField] = useState<"label" | "age">("label");
  const [editVal, setEditVal] = useState("");
  const [bw, setBw] = useState(false);

  // 범례
  const [legendPos, setLegendPos] = useState<{ x: number; y: number } | null>(null);
  const [legendBoxW, setLegendBoxW] = useState(210);
  const [legendBoxH, setLegendBoxH] = useState(0); // 0 = auto
  const [legendFontScale, setLegendFontScale] = useState(1.0);
  const [legendSelected, setLegendSelected] = useState(false);
  const legendDragRef = useRef<{ type: "move" | "resizeBox" | "resizeFont"; ox: number; oy: number; initW?: number; initH?: number; initF?: number } | null>(null);

  // Undo
  const [history, setHistory] = useState<{ nodes: GNode[]; lines: GLine[]; marriages: Marriage[] }[]>([]);
  const saveHistory = useCallback(() => {
    setHistory(h => [...h.slice(-30), { nodes: nodes.map(n => ({ ...n })), lines: lines.map(l => ({ ...l })), marriages: marriages.map(m => ({ ...m, childIds: [...m.childIds] })) }]);
  }, [nodes, lines, marriages]);
  const undo = useCallback(() => {
    setHistory(h => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      setNodes(prev.nodes); setLines(prev.lines); setMarriages(prev.marriages);
      return h.slice(0, -1);
    });
  }, []);

  const dragRef = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const [rubber, setRubber] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const rbStart = useRef<{ x: number; y: number } | null>(null);

  // 캔버스 실제 크기를 state로 관리 — display:none 탭에서 돌아올 때도 정확히 업데이트
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 500 });
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
    return { x: cx - r.left, y: cy - r.top };
  };

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

  const addNode = (gender: Gender) => {
    saveHistory();
    const r = wrapRef.current?.getBoundingClientRect();
    const x = r ? r.width / 2 - NS / 2 + (Math.random() - 0.5) * 120 : 200;
    const y = r ? r.height / 3 + (Math.random() - 0.5) * 80 : 150;
    setNodes(p => [...p, { id: uid(), gender, dead: false, client: false, label: "", age: "", x, y }]);
  };

  const toggleDead = () => {
    const sel = Array.from(selected).filter(id => nodes.some(n => n.id === id));
    if (!sel.length) return;
    saveHistory();
    setNodes(p => p.map(n => sel.includes(n.id) ? { ...n, dead: !n.dead } : n));
  };

  const toggleClient = useCallback(() => {
    const sel = Array.from(selected).filter(id => nodes.some(n => n.id === id));
    if (!sel.length) return;
    saveHistory();
    setNodes(p => p.map(n => sel.includes(n.id) ? { ...n, client: !n.client } : n));
  }, [selected, nodes, saveHistory]);

  const snapPos = (x: number, y: number, excludeId: string) => {
    let sx = x, sy = y;
    for (const n of nodes) {
      if (n.id === excludeId) continue;
      if (Math.abs(n.x - x) < SNAP) sx = n.x;
      if (Math.abs(n.y - y) < SNAP) sy = n.y;
      if (Math.abs((n.x + NS / 2) - (x + NS / 2)) < SNAP) sx = n.x;
      if (Math.abs((n.y + NS / 2) - (y + NS / 2)) < SNAP) sy = n.y;
    }
    return { x: sx, y: sy };
  };

  const doDelete = useCallback(() => {
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
  }, [selected, saveHistory]);

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
        setMarriages(p => p.map(m => m.id === connectingFrom ? { ...m, childIds: [...new Set([...m.childIds, id])] } : m));
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
    if (rubber && rubber.w > 4 && rubber.h > 4) {
      const { x, y, w, h } = rubber;
      const s = new Set<string>();
      nodes.forEach(n => { const cx = n.x + NS / 2, cy = n.y + NS / 2; if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) s.add(n.id); });
      lines.forEach(l => { const p1 = getEndpoint(l.from, nodes, lines), p2 = getEndpoint(l.to, nodes, lines); const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2; if (mx >= x && mx <= x + w && my >= y && my <= y + h) s.add(l.id); });
      if (s.size) setSelected(s);
    }
    dragRef.current = null; rbStart.current = null; legendDragRef.current = null; setRubber(null);
  };

  const onCanvasDown = (e: React.MouseEvent) => {
    if ((e.target as Element).tagName !== "svg") return;
    setLegendSelected(false);
    if (!connectingFrom) { setSelected(new Set()); rbStart.current = svgPt(e.clientX, e.clientY); }
  };

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
  };

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
    return (
      <g key={`m-${m.id}`}>
        <line x1={midX} y1={parentY} x2={midX} y2={dropY} stroke="#374151" strokeWidth={2} />
        {children.length > 1 && <line x1={Math.min(...xs)} y1={dropY} x2={Math.max(...xs)} y2={dropY} stroke="#374151" strokeWidth={2} />}
        {children.map(c => <line key={c.id} x1={nc(c).x} y1={dropY} x2={nc(c).x} y2={nc(c).y} stroke="#374151" strokeWidth={2} />)}
      </g>
    );
  };

  const renderShape = (n: GNode, isSel: boolean, isConn: boolean) => {
    const s = isSel ? "#3a6a4a" : isConn ? "#f59e0b" : "#222";
    const sw = isSel || isConn ? 3 : 2, half = NS / 2;
    const parts: React.ReactNode[] = [];
    const gap = 4; // 이중도형 간격

    if (n.gender === "남성") {
      if (n.client) parts.push(<rect key="outer" x={0} y={0} width={NS} height={NS} fill="#fff" stroke={s} strokeWidth={sw} />);
      parts.push(<rect key="s" x={n.client ? gap : 3} y={n.client ? gap : 3} width={NS - (n.client ? gap * 2 : 6)} height={NS - (n.client ? gap * 2 : 6)} fill="#fff" stroke={s} strokeWidth={sw} />);
    } else if (n.gender === "여성") {
      if (n.client) parts.push(<circle key="outer" cx={half} cy={half} r={half} fill="#fff" stroke={s} strokeWidth={sw} />);
      parts.push(<circle key="s" cx={half} cy={half} r={n.client ? half - gap : half - 3} fill="#fff" stroke={s} strokeWidth={sw} />);
    } else {
      // 논바이너리 마름모
      if (n.client) parts.push(<polygon key="outer" points={`${half},0 ${NS},${half} ${half},${NS} 0,${half}`} fill="#fff" stroke={s} strokeWidth={sw} />);
      parts.push(<polygon key="s" points={`${half},${n.client ? gap + 1 : 3} ${NS - (n.client ? gap + 1 : 3)},${half} ${half},${NS - (n.client ? gap + 1 : 3)} ${n.client ? gap + 1 : 3},${half}`} fill="#fff" stroke={s} strokeWidth={sw} />);
    }
    if (n.dead) { parts.push(<line key="x1" x1={8} y1={8} x2={NS - 8} y2={NS - 8} stroke={s} strokeWidth={sw} />, <line key="x2" x1={NS - 8} y1={8} x2={8} y2={NS - 8} stroke={s} strokeWidth={sw} />); }
    return parts;
  };

  const usedNodes = [...new Set([...nodes.map(n => n.gender), ...nodes.filter(n => n.dead).map(() => "사망" as const), ...nodes.filter(n => n.client).map(() => "내담자" as const)])];
  const usedLineTypes = [...new Set(lines.map(l => l.lineType))];
  const totalItems = usedNodes.length + usedLineTypes.length;
  const canvasW = canvasSize.w, canvasH = canvasSize.h;
  const lx = legendPos?.x ?? (canvasW - legendBoxW - 16);
  const autoH = totalItems * 24 * legendFontScale + 55 * legendFontScale;
  const lh = legendBoxH > 0 ? legendBoxH : autoH;
  const ly = legendPos?.y ?? (canvasH - lh - 16);

  const lineCategories = [
    { label: "가족관계", types: FAMILY_TYPES },
    { label: "정서거리", types: EMO_TYPES },
    { label: "갈등역동", types: CONFLICT_TYPES },
    { label: "학대", types: ABUSE_TYPES },
  ];

  return (
    <div className="flex flex-col h-full" style={{ fontFamily: "'Malgun Gothic', sans-serif" }}>

      {/* ── 상단 툴바 ── */}
      <div className="bg-white border-b border-gray-200 px-3 py-1.5 flex items-center gap-2 shrink-0 flex-wrap">
        {/* 인물 */}
        <div className="flex items-center gap-1">
          <TwoLineBtn top="□" bottom="남성" onClick={() => addNode("남성")} />
          <TwoLineBtn top="○" bottom="여성" onClick={() => addNode("여성")} />
          <TwoLineBtn top="◇" bottom="논바이너리" onClick={() => addNode("논바이너리")} />
          <TwoLineBtn top="사망" bottom="토글" onClick={toggleDead}
            disabled={!Array.from(selected).some(id => nodes.some(n => n.id === id))} />
          <TwoLineBtn top="내담자" bottom="토글" onClick={toggleClient}
            disabled={!Array.from(selected).some(id => nodes.some(n => n.id === id))}
            active={Array.from(selected).some(id => nodes.find(n => n.id === id)?.client)} />
        </div>

        <div className="h-6 w-px bg-gray-200" />

        {/* 선 카테고리 */}
        {lineCategories.map(cat => (
          <div key={cat.label} className="flex items-center gap-1">
            <span className="text-[9px] text-gray-400 font-bold mr-0.5 shrink-0">{cat.label}</span>
            {cat.types.map(t => (
              <TwoLineBtn key={t} preview={t} bottom={t} onClick={() => setLineType(t)} active={lineType === t} bw={bw} />
            ))}
            <div className="h-6 w-px bg-gray-200 mx-0.5" />
          </div>
        ))}

        {/* 기능 */}
        <div className="flex items-center gap-1">
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

        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center gap-1">
            <button onClick={() => setBw(v => !v)}
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${bw ? "bg-gray-700" : "bg-[#3a6a4a]"}`}>
              <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform shadow ${bw ? "translate-x-3" : "translate-x-0.5"}`} />
            </button>
            <span className="text-[10px] text-gray-500">{bw ? "흑백" : "컬러"}</span>
          </div>
          <TwoLineBtn top="SVG" bottom="저장" onClick={saveImg} />
          <TwoLineBtn top="삭" bottom="제" onClick={doDelete} disabled={selected.size === 0} danger />
        </div>
      </div>

      {/* ── 캔버스 ── */}
      <div ref={wrapRef}
        className="flex-1 relative overflow-hidden"
        style={{ background: bw ? "#fff" : "#fafafa", backgroundImage: bw ? "none" : "radial-gradient(circle, #d1d5db 1px, transparent 1px)", backgroundSize: "24px 24px" }}
        onMouseDown={onCanvasDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>

        {connectingFrom && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-amber-500 text-white text-xs px-4 py-1.5 rounded-full shadow font-medium pointer-events-none">
            {connectingMode === "child" ? "자녀 노드 클릭 — Esc 취소" : "연결할 도형 클릭 — Esc 취소"}
          </div>
        )}

        <svg ref={svgRef} width="100%" height="100%"
          viewBox={`0 0 ${canvasW} ${canvasH}`}
          style={{ cursor: connectingFrom ? "crosshair" : "default" }}>

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
                {/* 나이 (도형 안) */}
                {editId === n.id && editField === "age" ? (
                  <foreignObject x={4} y={4} width={NS - 8} height={20}>
                    <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
                      onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditId(null); }}
                      style={{ width: "100%", fontSize: 10, textAlign: "center", border: "1px solid #3a6a4a", borderRadius: 2, padding: "1px 2px", outline: "none", background: "rgba(255,255,255,0.9)" }} />
                  </foreignObject>
                ) : (
                  <text x={NS / 2} y={n.gender === "논바이너리" ? (n.client ? NS / 2 + 4 : 22) : (n.client ? NS / 2 + 4 : 16)} textAnchor="middle" fontSize={10}
                    fill={n.age ? "#444" : "#ddd"} fontFamily="'Malgun Gothic', sans-serif"
                    style={{ cursor: "text" }}
                    onClick={e => { e.stopPropagation(); startEdit(e, n.id, "age"); }}>
                    {n.age || "나이"}
                  </text>
                )}
                {/* 이름 (도형 아래) */}
                {editId === n.id && editField === "label" ? (
                  <foreignObject x={-20} y={NS + 2} width={NS + 40} height={26}>
                    <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
                      onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditId(null); }}
                      style={{ width: "100%", fontSize: 11, textAlign: "center", border: "1px solid #3a6a4a", borderRadius: 3, padding: "1px 3px", outline: "none" }} />
                  </foreignObject>
                ) : (
                  <text x={NS / 2} y={NS + 15} textAnchor="middle" fontSize={11} fontWeight="500"
                    fill={n.label ? "#222" : "#ccc"} fontFamily="'Malgun Gothic', sans-serif">
                    {n.label || "더블클릭"}
                  </text>
                )}
              </g>
            );
          })}

          {/* 범례 */}
          {totalItems > 0 && (() => {
            const fs = 10 * legendFontScale, rowH = 22 * legendFontScale;
            const bxW = legendBoxW, bxH = legendBoxH > 0 ? legendBoxH : autoH;
            const isLegSel = legendSelected;
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

                <text x={0} y={12 * legendFontScale} fontSize={fs + 1} fontWeight="700" fill="#6b7280" fontFamily="'Malgun Gothic', sans-serif">범 례</text>

                {usedNodes.length > 0 && <text x={0} y={26 * legendFontScale} fontSize={fs - 1} fill="#9ca3af" fontFamily="'Malgun Gothic', sans-serif">인물</text>}
                {usedNodes.map((t, i) => (
                  <g key={t} transform={`translate(0,${30 * legendFontScale + i * rowH})`}>
                    {t === "남성" && <rect x={0} y={2} width={14 * legendFontScale} height={14 * legendFontScale} fill="#fff" stroke="#222" strokeWidth={1.5} />}
                    {t === "여성" && <circle cx={7 * legendFontScale} cy={9 * legendFontScale} r={7 * legendFontScale} fill="#fff" stroke="#222" strokeWidth={1.5} />}
                    {t === "논바이너리" && <polygon points={`${7 * legendFontScale},1 ${14 * legendFontScale},${9 * legendFontScale} ${7 * legendFontScale},${17 * legendFontScale} 0,${9 * legendFontScale}`} fill="#fff" stroke="#222" strokeWidth={1.5} />}
                    {t === "사망" && <><rect x={0} y={2} width={14 * legendFontScale} height={14 * legendFontScale} fill="#fff" stroke="#222" strokeWidth={1.5} /><line x1={2} y1={4} x2={12 * legendFontScale} y2={14 * legendFontScale} stroke="#222" strokeWidth={1.5} /><line x1={12 * legendFontScale} y1={4} x2={2} y2={14 * legendFontScale} stroke="#222" strokeWidth={1.5} /></>}
                    {t === "내담자" && <><rect x={0} y={1} width={16 * legendFontScale} height={16 * legendFontScale} fill="#fff" stroke="#222" strokeWidth={1.5} /><rect x={3 * legendFontScale} y={4 * legendFontScale} width={10 * legendFontScale} height={10 * legendFontScale} fill="#fff" stroke="#222" strokeWidth={1.5} /></>}
                    <text x={20 * legendFontScale} y={14 * legendFontScale} fontSize={fs} fill="#374151" fontFamily="'Malgun Gothic', sans-serif">{t}</text>
                  </g>
                ))}
                {usedLineTypes.length > 0 && <text x={0} y={30 * legendFontScale + usedNodes.length * rowH + 8 * legendFontScale} fontSize={fs - 1} fill="#9ca3af" fontFamily="'Malgun Gothic', sans-serif">관계/정서선</text>}
                {usedLineTypes.map((t, i) => (
                  <g key={t} transform={`translate(0,${34 * legendFontScale + usedNodes.length * rowH + 12 * legendFontScale + i * rowH})`}>
                    <g transform={`scale(${legendFontScale})`}><LinePreview type={t} size={36} bw={bw} /></g>
                    <text x={42 * legendFontScale} y={13 * legendFontScale} fontSize={fs} fill="#374151" fontFamily="'Malgun Gothic', sans-serif">{t}</text>
                  </g>
                ))}

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

          {rubber && (
            <rect x={rubber.x} y={rubber.y} width={rubber.w} height={rubber.h}
              fill="rgba(58,106,74,0.08)" stroke="#3a6a4a" strokeWidth={1} strokeDasharray="4 2" />
          )}
        </svg>

        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-gray-300">
              <div className="text-4xl mb-2">□ ○ ◇</div>
              <div className="text-sm font-medium">상단에서 인물을 추가하세요</div>
            </div>
          </div>
        )}
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
