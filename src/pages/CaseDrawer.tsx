import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  ChevronDown, ChevronRight, Plus, Mic, FileText, BarChart3, TreePine, ClipboardList, Users, Search, FolderOpen, Trash2, Pencil, Lock, KeyRound,
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ── 사례서랍: 이미 컴퓨터에 정리해 둔 파일을 "경로로 연결"만 함 (복사 X) ──
// 정리정보(기본정보·회차구성 등 앱에서 직접 입력하는 내용)는 사용자가 지정한 폴더 안에
// 실제 파일(<사례폴더>/_사례정보.json)로 저장된다 — 앱을 지우거나 재설치해도 그 폴더만
// 있으면 통째로 복구됨. 앱 저장공간(userData)엔 "어느 폴더를 쓰는지"와 "앱 잠금 비번 해시"만 둔다.
// 이 비밀번호는 파일 자체의 암호화가 아니라 "앱을 여는 관문" 역할 — 진짜 도난·분실 방어는
// 사용자가 별도로 거는 BitLocker/VeraCrypt 등 디스크·폴더 암호화가 담당한다.

type FileRef = { path: string; addedAt: string } | null;

type ExtraDoc = { id: string; date: string; path: string; sessionNo?: number | null; note?: string };

type SessionRecord = {
  no: number;
  date: string;
  audio: FileRef;
  transcriptJson: FileRef;
  transcriptWord: FileRef;
  analysis: FileRef;
};

type BasicInfo = {
  age: string;
  phone: string;
  visitReason: string;       // 내방동기
  mainComplaint: string;     // 주호소
  priorCounseling: string;   // 이전상담이력
  medication: string;        // 약물복용여부
  suicidalIdeation: string;  // 자살사고 유무
};

const emptyBasicInfo = (): BasicInfo => ({
  age: "", phone: "", visitReason: "", mainComplaint: "",
  priorCounseling: "", medication: "", suicidalIdeation: "",
});

const BASIC_INFO_FIELDS: { key: keyof BasicInfo; label: string }[] = [
  { key: "age", label: "나이" },
  { key: "phone", label: "전화번호" },
  { key: "visitReason", label: "내방동기" },
  { key: "mainComplaint", label: "주호소" },
  { key: "priorCounseling", label: "이전상담이력" },
  { key: "medication", label: "약물복용여부" },
  { key: "suicidalIdeation", label: "자살사고 유무" },
];

// 사례 구분용 색 라벨 — 소속(학교센터/개인/타센터 등)을 색으로 구분
const LABEL_COLORS: { key: string; name: string; bg: string }[] = [
  { key: "yellow", name: "노랑", bg: "#fbbf24" },
  { key: "green",  name: "초록", bg: "#34d399" },
  { key: "purple", name: "보라", bg: "#a78bfa" },
  { key: "blue",   name: "파랑", bg: "#60a5fa" },
  { key: "pink",   name: "분홍", bg: "#f472b6" },
  { key: "orange", name: "주황", bg: "#fb923c" },
];
const labelBg = (key: string | null | undefined) => LABEL_COLORS.find((c) => c.key === key)?.bg;

type CaseRecord = {
  id: string;
  folderName: string; // 생성 시 한 번 정해지는 실제 하위 폴더명 — 이후 이름 수정해도 안 바뀜
  name: string;
  startDate: string;
  labelColor?: string | null; // LABEL_COLORS의 key, 없으면 라벨 없음
  drawer?: string | null;     // 소속 서랍(카테고리) id — null/없음 = 미분류
  memo?: string;              // 특이사항 메모
  memoEtc?: string;           // 기타 메모
  genogram: FileRef;
  psychTests: ExtraDoc[];
  supervisions: ExtraDoc[];
  sessions: SessionRecord[];
  basicInfo: BasicInfo;
};

// 서랍(카테고리) — 이름은 자유롭게 바꿀 수 있어야 하므로 id로 사례와 연결한다.
// 목록은 사례 루트폴더의 _사례서랍.json 에 실제 파일로 저장(사례서랍 저장 철학과 동일).
type Drawer = { id: string; name: string };

type CaseSettings = { rootFolder: string | null; passwordHash: string | null; passwordSalt: string | null };

const caseDrawerAPI = (window as any).caseDrawerAPI as {
  getSettings: () => Promise<CaseSettings>;
  setSettings: (data: CaseSettings) => Promise<boolean>;
  selectFolder: () => Promise<string | null>;
  listDirs: (rootPath: string) => Promise<string[]>;
  mkdir: (dirPath: string) => Promise<boolean>;
  writeText: (filePath: string, content: string) => Promise<boolean>;
  selectFile: (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>;
  readText: (filePath: string) => Promise<string | null>;
  readBinary: (filePath: string) => Promise<string | null>; // base64
  fileExists: (filePath: string) => Promise<boolean>;
  openExternal: (filePath: string) => Promise<boolean>;
} | undefined;

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const isTextLike = (p: string) => /\.(json|txt)$/i.test(p);
const isAudio = (p: string) => /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(p);
const isImage = (p: string) => /\.(png|jpg|jpeg|gif|webp)$/i.test(p);
const isPdf = (p: string) => /\.pdf$/i.test(p);
const isHwpx = (p: string) => /\.hwpx$/i.test(p); // 옛 .hwp(바이너리)는 앱 안에서 못 읽음 — 대상 아님
const isDocx = (p: string) => /\.docx$/i.test(p); // 옛 .doc(바이너리)는 앱 안에서 못 읽음 — 대상 아님
// 축어록 첨부는 json 직접 첨부 없이 문서 파일(워드/한글/PDF)만 — 열람은 FilePreviewDialog가 담당
const TRANSCRIPT_DOC_FILTERS = [{ name: "축어록 문서", extensions: ["docx", "doc", "hwpx", "hwp", "pdf"] }];
const fileUrl = (p: string) => "file:///" + p.replace(/\\/g, "/").replace(/^\/+/, "");
const joinPath = (...parts: string[]) => parts.join(/\\/.test(parts[0]) ? "\\" : "/");
const sanitizeForFolder = (s: string) => s.replace(/[<>:"/\\|?*]/g, "_").trim() || "이름없음";

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function emptyCase(): CaseRecord {
  return {
    id: uid(), folderName: "", name: "", startDate: new Date().toISOString().slice(0, 10),
    labelColor: null,
    genogram: null, psychTests: [], supervisions: [],
    sessions: [{ no: 1, date: new Date().toISOString().slice(0, 10), audio: null, transcriptJson: null, transcriptWord: null, analysis: null }],
    basicInfo: emptyBasicInfo(),
  };
}

// ── 색 라벨 선택기(새 사례·정보 수정 공용) ────────────────────────────
function LabelPicker({ value, onChange }: { value: string | null | undefined; onChange: (v: string | null) => void }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button onClick={() => onChange(null)} title="라벨 없음"
        className={`w-6 h-6 rounded-full border text-[10px] text-gray-400 bg-white
          ${!value ? "ring-2 ring-offset-1 ring-gray-400 border-gray-400" : "border-gray-200 hover:border-gray-400"}`}>
        ✕
      </button>
      {LABEL_COLORS.map((c) => (
        <button key={c.key} onClick={() => onChange(c.key)} title={c.name}
          style={{ background: c.bg }}
          className={`w-6 h-6 rounded-full border border-black/10
            ${value === c.key ? "ring-2 ring-offset-1 ring-gray-500" : "hover:scale-110 transition-transform"}`} />
      ))}
    </div>
  );
}

// ── 파일 첨부 버튼(작은 칸 하나) ────────────────────────────────────────
function AttachSlot({
  label, value, onAttach, filters,
}: {
  label: string; value: FileRef; onAttach: (path: string) => void;
  filters?: { name: string; extensions: string[] }[];
}) {
  const pick = async () => {
    if (!caseDrawerAPI) return;
    const p = await caseDrawerAPI.selectFile(filters);
    if (p) onAttach(p);
  };
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="text-xs text-gray-500 w-20 shrink-0">{label}</span>
      <button onClick={pick}
        className="flex-1 text-left text-xs px-2 py-1.5 rounded-md border border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-600 truncate">
        {value ? baseName(value.path) : "파일 선택..."}
      </button>
    </div>
  );
}

// file:// fetch는 Chromium의 webSecurity가 막는다(웹 페이지에서 로컬 파일을 직접
// fetch 못 함 — <img>/<audio> src= 는 되지만 fetch()는 안 됨). 그래서 PDF·워드는
// Electron 메인 프로세스(Node, 제약 없음)가 대신 읽어 base64로 건네준 걸 디코드한다.
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── PDF 읽기 전용 뷰어 (pdf.js, 확대/축소 지원) ──────────────────────
// 캔버스는 넉넉한 해상도(scale 2.0)로 한 번만 렌더링해두고, 확대/축소는
// CSS width%로 처리한다(버튼 누를 때마다 pdf.js로 다시 그리면 느리고 깜빡임).
const PDF_RENDER_SCALE = 2.0;
function PdfInlineViewer({ path }: { path: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "error" | "done">("loading");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [zoom, setZoom] = useState(65); // 렌더 해상도가 2.0배라 65%가 실제 크기와 비슷함

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErrorMsg("");
    setZoom(65);
    const container = containerRef.current;
    if (container) container.innerHTML = "";

    (async () => {
      try {
        const b64 = await caseDrawerAPI?.readBinary(path);
        if (!b64) throw new Error("readBinary가 빈 값을 반환함(파일 경로 문제일 수 있음)");
        const doc = await pdfjsLib.getDocument({ data: base64ToBytes(b64) }).promise;
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = "pdf-page rounded-md border border-gray-200 shadow-sm mb-3 mx-auto block";
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          containerRef.current?.appendChild(canvas);
        }
        if (!cancelled) setStatus("done");
      } catch (e) {
        if (!cancelled) { setErrorMsg(e instanceof Error ? `${e.name}: ${e.message}` : String(e)); setStatus("error"); }
      }
    })();

    return () => { cancelled = true; };
  }, [path]);

  useEffect(() => {
    containerRef.current?.querySelectorAll<HTMLCanvasElement>(".pdf-page")
      .forEach((c) => { c.style.width = `${zoom}%`; c.style.height = "auto"; });
  }, [zoom, status]);

  if (status === "error") {
    return (
      <div className="text-sm text-gray-500 space-y-2">
        <p>PDF를 여는 데 실패했어요.</p>
        <pre className="text-[11px] text-red-500 bg-red-50 border border-red-100 rounded p-2 whitespace-pre-wrap break-all">{errorMsg}</pre>
        <Button variant="outline" onClick={() => caseDrawerAPI?.openExternal(path)}>시스템 기본 프로그램으로 열기</Button>
      </div>
    );
  }
  return (
    <div>
      {status === "done" && (
        <div className="sticky top-0 z-10 flex items-center justify-center gap-2 bg-white/95 backdrop-blur py-1.5 mb-2 border-b border-gray-100">
          <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setZoom((z) => Math.max(25, z - 15))}>−</Button>
          <span className="text-xs text-gray-500 w-12 text-center tabular-nums">{zoom}%</span>
          <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setZoom((z) => Math.min(300, z + 15))}>+</Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setZoom(65)}>100%</Button>
        </div>
      )}
      {status === "loading" && <p className="text-xs text-gray-400 mb-2">불러오는 중...</p>}
      <div ref={containerRef} />
    </div>
  );
}

// ── hwpx 읽기 전용 뷰어 (서버가 문단·표를 뽑아 텍스트로 반환, 정밀 서식 재현 X) ──
type HwpxBlock = { type: "text"; text: string } | { type: "table"; rows: string[][] };
function HwpxInlineViewer({ path }: { path: string }) {
  const [blocks, setBlocks] = useState<HwpxBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBlocks(null);
    setError(null);
    fetch("http://127.0.0.1:5577/api/file/hwpx-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    })
      .then((r) => r.json())
      .then((data) => { if (data.ok) setBlocks(data.blocks); else setError(data.error || "미리보기를 만들 수 없어요."); })
      .catch(() => setError("서버에 연결할 수 없어요."));
  }, [path]);

  if (error) {
    return (
      <div className="text-sm text-gray-500 space-y-2">
        <p>{error}</p>
        <Button variant="outline" onClick={() => caseDrawerAPI?.openExternal(path)}>시스템 기본 프로그램으로 열기</Button>
      </div>
    );
  }
  if (!blocks) return <p className="text-xs text-gray-400">불러오는 중...</p>;
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-400">내용만 읽기 전용으로 보여줘요 — 실제 서식(글꼴·줄간격)은 한글 프로그램에서 열어야 정확해요.</p>
      {blocks.map((b, i) =>
        b.type === "table" ? (
          <table key={i} className="w-full text-xs border-collapse">
            <tbody>
              {b.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="border border-gray-200 px-2 py-1 align-top whitespace-pre-wrap">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p key={i} className="text-sm leading-relaxed whitespace-pre-wrap">{b.text}</p>
        )
      )}
    </div>
  );
}

// ── docx 읽기 전용 뷰어 (mammoth.js, 브라우저에서 바로 html로 변환 — 서버 필요 없음) ──
function DocxInlineViewer({ path }: { path: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    setError(null);
    (async () => {
      try {
        const b64 = await caseDrawerAPI?.readBinary(path);
        if (!b64) throw new Error("파일을 읽을 수 없음");
        const bytes = base64ToBytes(b64);
        const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
        setHtml(result.value);
      } catch {
        setError("워드 문서를 여는 데 실패했어요. 파일이 손상되었거나 옛 .doc 형식일 수 있어요.");
      }
    })();
  }, [path]);

  if (error) {
    return (
      <div className="text-sm text-gray-500 space-y-2">
        <p>{error}</p>
        <Button variant="outline" onClick={() => caseDrawerAPI?.openExternal(path)}>시스템 기본 프로그램으로 열기</Button>
      </div>
    );
  }
  if (html === null) return <p className="text-xs text-gray-400">불러오는 중...</p>;
  return (
    <div>
      <p className="text-[11px] text-gray-400 mb-2">내용만 읽기 전용으로 보여줘요 — 정확한 서식은 워드/한글 프로그램에서 열어야 확인돼요.</p>
      <div className="docx-preview text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// ── 파일 내용 뷰어 (팝업·사례연구 책상 패널 공용 — 형식별 분기 한 곳으로) ──
function FileInlineViewer({ label, path }: { label: string; path: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (isTextLike(path) && caseDrawerAPI) {
      caseDrawerAPI.readText(path).then(setText);
    }
  }, [path]);

  if (isAudio(path)) return <audio controls src={fileUrl(path)} className="w-full" />;
  if (isImage(path)) return <img src={fileUrl(path)} alt={label} className="max-w-full rounded-md" />;
  if (isPdf(path)) return <PdfInlineViewer path={path} />;
  if (isHwpx(path)) return <HwpxInlineViewer path={path} />;
  if (isDocx(path)) return <DocxInlineViewer path={path} />;
  if (isTextLike(path)) {
    return (
      <pre className="text-xs whitespace-pre-wrap bg-gray-50 rounded-md p-3 border border-gray-200 leading-relaxed">
        {text === null ? "불러오는 중..." : text || "(내용 없음)"}
      </pre>
    );
  }
  return (
    <div className="text-sm text-gray-500 space-y-2">
      <p>이 형식(예: 옛 .doc/.hwp 문서)은 곤글박이 안에서 직접 보여줄 수 없어요.</p>
      <Button variant="outline" onClick={() => caseDrawerAPI?.openExternal(path)}>
        시스템 기본 프로그램으로 열기
      </Button>
    </div>
  );
}

// ── 파일 내용 미리보기 팝업 ──────────────────────────────────────────
function FilePreviewDialog({ file, onClose }: { file: { label: string; path: string } | null; onClose: () => void }) {
  if (!file) return null;
  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-[#2d1f0e]">{file.label} — {baseName(file.path)}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto">
          <FileInlineViewer label={file.label} path={file.path} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── 사례 전체 자료(가계도/심리검사/슈퍼비전) — 언제든 추가 가능 ─────────
function ExtraDocList({
  title, icon, docs, onAdd, onOpen, onRemove,
}: {
  title: string; icon: React.ReactNode; docs: ExtraDoc[];
  onAdd: (path: string) => void; onOpen: (label: string, path: string) => void;
  onRemove: (id: string) => void;
}) {
  const add = async () => {
    if (!caseDrawerAPI) return;
    const p = await caseDrawerAPI.selectFile();
    if (p) onAdd(p);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-xs font-bold text-gray-500">{title}</span>
        <button onClick={add} className="ml-auto text-[10px] px-2 py-0.5 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-100 flex items-center gap-0.5">
          <Plus className="w-3 h-3" /> 추가
        </button>
      </div>
      {docs.length === 0 && <p className="text-[11px] text-gray-400 pl-5">아직 없음</p>}
      <div className="flex flex-wrap gap-1.5 pl-5">
        {docs.map((d) => (
          <div key={d.id} className="flex items-center gap-0.5 rounded-md bg-white border border-gray-200 hover:bg-gray-50">
            <button onClick={() => onOpen(title, d.path)} className="text-[11px] pl-2 pr-1 py-1 text-gray-600">
              {d.date}{d.sessionNo ? ` · ${d.sessionNo}회차` : ""} · {baseName(d.path)}
            </button>
            <button onClick={() => { if (window.confirm("이 첨부를 삭제할까요? (원본 파일은 지워지지 않아요)")) onRemove(d.id); }}
              title="삭제" className="pr-1.5 pl-0.5 py-1 text-gray-300 hover:text-red-500">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 사례 정보(내담자명·상담 시작일) 수정 모달 ──────────────────────────
function EditCaseInfoDialog({
  data, open, onClose, onSave, drawers,
}: {
  data: CaseRecord | null; open: boolean; onClose: () => void;
  onSave: (name: string, startDate: string, labelColor: string | null, drawer: string | null) => void;
  drawers: Drawer[];
}) {
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [labelColor, setLabelColor] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  useEffect(() => {
    if (open && data) {
      setName(data.name); setStartDate(data.startDate);
      setLabelColor(data.labelColor ?? null); setDrawer(data.drawer ?? null);
    }
  }, [open, data]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="text-[#2d1f0e]">사례 정보 수정</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">내담자명</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">상담 시작일</Label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">색 라벨 (선택 — 필요에 따라 붙여서 자유롭게 구분할 수 있어요)</Label>
            <LabelPicker value={labelColor} onChange={setLabelColor} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">사례서랍</Label>
            <DrawerSelect drawers={drawers} value={drawer} onChange={setDrawer} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>취소</Button>
          <Button disabled={!name.trim()} onClick={() => { onSave(name.trim(), startDate, labelColor, drawer); onClose(); }}
            className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white">저장</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 사례 하나(가로로 긴 버튼 + 드롭다운) ───────────────────────────────
function CaseRow({
  data, open, onToggle, onChange, onOpenFile, onDelete, onEditInfo, onOpenDesk,
}: {
  data: CaseRecord; open: boolean; onToggle: () => void;
  onChange: (next: CaseRecord) => void;
  onOpenFile: (label: string, path: string) => void;
  onDelete: () => void;
  onEditInfo: () => void;
  onOpenDesk: (tab?: DeskTab) => void;
}) {
  const setGenogram = (path: string) => onChange({ ...data, genogram: { path, addedAt: new Date().toISOString() } });
  const clearGenogram = () => onChange({ ...data, genogram: null });
  const addPsychTest = (path: string) => onChange({
    ...data, psychTests: [...data.psychTests, { id: uid(), date: new Date().toISOString().slice(0, 10), path }],
  });
  const removePsychTest = (id: string) => onChange({ ...data, psychTests: data.psychTests.filter((d) => d.id !== id) });
  const addSupervision = (path: string) => onChange({
    ...data, supervisions: [...data.supervisions, { id: uid(), date: new Date().toISOString().slice(0, 10), path }],
  });
  const removeSupervision = (id: string) => onChange({ ...data, supervisions: data.supervisions.filter((d) => d.id !== id) });
  const setBasicInfo = (key: keyof BasicInfo, value: string) =>
    onChange({ ...data, basicInfo: { ...(data.basicInfo || emptyBasicInfo()), [key]: value } });

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-gray-50 transition-colors bg-white">
        <button onClick={onToggle} className="flex items-center gap-2.5 flex-1 min-w-0 text-left">
          {open ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
          {labelBg(data.labelColor) && (
            <span className="w-2.5 h-5 rounded-full shrink-0" style={{ background: labelBg(data.labelColor) }} />
          )}
          <FolderOpen className="w-4 h-4 text-[#3a6a4a] shrink-0" />
          <span className="font-medium text-[#2d1f0e] text-sm truncate">{data.name || "(이름 없음)"}</span>
          <span className="text-xs text-gray-400 shrink-0">상담 시작일 {data.startDate}</span>
          <span className="text-[11px] text-gray-400 shrink-0">{data.sessions.length}회차</span>
        </button>
        {/* 자료 바로가기 — 누르면 사례연구 책상이 그 자료 탭으로 열림 */}
        <div className="shrink-0 hidden md:flex items-center gap-1">
          {DESK_TABS.map((t) => (
            <button key={t.key} onClick={() => onOpenDesk(t.key)} title={`${t.label} 펼쳐보기`}
              className="text-[10px] px-2 py-1 rounded-full border border-transparent text-gray-400
                hover:text-[#2d7a3a] hover:bg-[#f0f7f2] hover:border-[#a8d8a8] transition-colors">
              {t.label}
            </button>
          ))}
        </div>
        <button onClick={() => onOpenDesk()} title="이 사례로 보고서 만들기"
          className="shrink-0 flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 rounded-md
            bg-[#f0f7f2] border border-[#a8d8a8] text-[#2d7a3a] hover:bg-[#e0f0e8]">
          <ClipboardList className="w-3.5 h-3.5" /> 사례연구 책상
        </button>
        <button onClick={onEditInfo} title="사례 정보 수정"
          className="shrink-0 p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button onClick={onDelete} title="사례 삭제"
          className="shrink-0 p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-gray-100">
          {/* 내담자 기본정보 */}
          <div className="space-y-2 bg-gray-50 rounded-lg p-3">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">내담자 기본정보</p>
            <div className="grid grid-cols-2 gap-2">
              {BASIC_INFO_FIELDS.map(({ key, label }) => (
                <div key={key} className="flex items-center gap-1.5">
                  <span className="text-[11px] text-gray-500 w-[70px] shrink-0">{label}</span>
                  <input
                    value={(data.basicInfo || emptyBasicInfo())[key]}
                    onChange={(e) => setBasicInfo(key, e.target.value)}
                    className="flex-1 min-w-0 text-xs px-2 py-1 rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 사례 전체 자료 */}
          <div className="space-y-2.5 bg-gray-50 rounded-lg p-3">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">사례 전체 자료 (회차 무관)</p>
            <ExtraDocList title="가계도" icon={<TreePine className="w-3.5 h-3.5 text-[#3a6a4a]" />}
              docs={data.genogram ? [{ id: "gg", date: data.genogram.addedAt.slice(0, 10), path: data.genogram.path }] : []}
              onAdd={setGenogram} onOpen={onOpenFile} onRemove={() => clearGenogram()} />
            <ExtraDocList title="심리검사 보고서" icon={<ClipboardList className="w-3.5 h-3.5 text-[#c06010]" />}
              docs={data.psychTests} onAdd={addPsychTest} onOpen={onOpenFile} onRemove={removePsychTest} />
            <ExtraDocList title="슈퍼비전 자료" icon={<Users className="w-3.5 h-3.5 text-[#2060a0]" />}
              docs={data.supervisions} onAdd={addSupervision} onOpen={onOpenFile} onRemove={removeSupervision} />
          </div>

          {/* 회차별 자료 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">회차별 자료</p>
              <button
                onClick={() => onChange({
                  ...data,
                  sessions: [...data.sessions, {
                    no: (data.sessions.at(-1)?.no ?? 0) + 1,
                    date: new Date().toISOString().slice(0, 10),
                    audio: null, transcriptJson: null, transcriptWord: null, analysis: null,
                  }],
                })}
                className="text-[10px] px-2 py-0.5 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-100 flex items-center gap-0.5">
                <Plus className="w-3 h-3" /> 회차 추가
              </button>
            </div>
            {data.sessions.map((s, i) => (
              <div key={s.no} className="rounded-lg border border-gray-100 px-3 py-2">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs font-bold text-[#2d1f0e]">{s.no}회차</span>
                  <input type="date" value={s.date}
                    onChange={(e) => {
                      const sessions = [...data.sessions];
                      sessions[i] = { ...s, date: e.target.value };
                      onChange({ ...data, sessions });
                    }}
                    className="text-[11px] text-gray-400 border-none bg-transparent" />
                </div>
                <div className="flex flex-wrap gap-2">
                  {([
                    ["음성", "audio", <Mic className="w-3 h-3" />],
                    ["축어록", "transcriptWord", <FileText className="w-3 h-3" />],
                    ["분석", "analysis", <BarChart3 className="w-3 h-3" />],
                  ] as const).map(([label, key, icon]) => {
                    const val = (s as any)[key] as FileRef;
                    const attach = async () => {
                      const p = await caseDrawerAPI?.selectFile(key === "transcriptWord" ? TRANSCRIPT_DOC_FILTERS : undefined);
                      if (!p) return;
                      const sessions = [...data.sessions];
                      sessions[i] = { ...s, [key]: { path: p, addedAt: new Date().toISOString() } };
                      onChange({ ...data, sessions });
                    };
                    const clear = () => {
                      if (!window.confirm(`'${label}' 첨부를 없앨까요? (원본 파일은 지워지지 않아요)`)) return;
                      const sessions = [...data.sessions];
                      sessions[i] = { ...s, [key]: null };
                      onChange({ ...data, sessions });
                    };
                    return (
                      <div key={key}
                        className={`text-[11px] rounded-md border flex items-center overflow-hidden
                          ${val ? "bg-[#f0f7f2] border-[#a8d8a8] text-[#2d7a3a]" : "bg-gray-50 border-gray-200 text-gray-400"}`}>
                        <button onClick={() => (val ? onOpenFile(label, val.path) : attach())}
                          className="px-2.5 py-1.5 flex items-center gap-1 hover:opacity-80">
                          {icon} {label}{val ? ` · ${baseName(val.path)}` : ""}
                        </button>
                        {val && (
                          <>
                            <button onClick={attach} title="다시 첨부(교체)" className="px-1.5 py-1.5 hover:bg-white/60">
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button onClick={clear} title="첨부 없애기" className="px-1.5 py-1.5 hover:bg-white/60 hover:text-red-500">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* 메모 — 특이사항 / 기타 */}
          <div className="space-y-2">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">메모</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <span className="text-[11px] text-gray-500">특이사항</span>
                <textarea
                  value={data.memo ?? ""}
                  onChange={(e) => onChange({ ...data, memo: e.target.value })}
                  placeholder="위기 신호, 유의할 점 등"
                  rows={3}
                  className="w-full text-xs px-2.5 py-2 rounded-md border border-gray-200 bg-white leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[11px] text-gray-500">기타 메모</span>
                <textarea
                  value={data.memoEtc ?? ""}
                  onChange={(e) => onChange({ ...data, memoEtc: e.target.value })}
                  placeholder="일정, 행정사항 등 자유 기록"
                  rows={3}
                  className="w-full text-xs px-2.5 py-2 rounded-md border border-gray-200 bg-white leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]"
                />
              </div>
            </div>
          </div>

          <button onClick={onToggle}
            className="w-full flex items-center justify-center gap-1 py-2 rounded-lg text-[11px] text-gray-400 hover:text-gray-600 hover:bg-gray-50 border border-gray-100">
            <ChevronDown className="w-3.5 h-3.5 rotate-180" /> 접기
          </button>
        </div>
      )}
    </div>
  );
}

// ── 서랍 선택 드롭다운 (새 사례 만들기·사례 정보 수정 공용) ──────────────
function DrawerSelect({ drawers, value, onChange }: {
  drawers: Drawer[]; value: string | null | undefined; onChange: (v: string | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full text-xs px-2.5 py-2 rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]">
      <option value="">미분류</option>
      {drawers.map((d) => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  );
}

// ── 새 사례 만들기 모달 ────────────────────────────────────────────────
function NewCaseDialog({ open, onClose, onCreate, drawers }: {
  open: boolean; onClose: () => void; onCreate: (c: CaseRecord) => void; drawers: Drawer[];
}) {
  const [draft, setDraft] = useState<CaseRecord>(emptyCase());
  useEffect(() => { if (open) setDraft(emptyCase()); }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader><DialogTitle className="text-[#2d1f0e]">사례자료 만들기</DialogTitle></DialogHeader>
        <div className="flex-1 overflow-auto space-y-3 px-1">
          <div className="space-y-1">
            <Label className="text-xs">내담자명</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="예: 김OO" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">상담 시작일</Label>
            <Input type="date" value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">색 라벨 (선택 — 필요에 따라 붙여서 자유롭게 구분할 수 있어요)</Label>
            <LabelPicker value={draft.labelColor} onChange={(v) => setDraft({ ...draft, labelColor: v })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">사례서랍 (선택 — 카테고리별로 나눠 보관할 수 있어요)</Label>
            <DrawerSelect drawers={drawers} value={draft.drawer} onChange={(v) => setDraft({ ...draft, drawer: v })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">가계도 (선택, 나중에 다시 첨부해 수정 가능)</Label>
            <AttachSlot label="가계도" value={draft.genogram}
              onAttach={(p) => setDraft({ ...draft, genogram: { path: p, addedAt: new Date().toISOString() } })} />
          </div>
          <div className="space-y-1 border border-gray-100 rounded-lg p-2.5">
            <Label className="text-xs">1회차 자료 (선택)</Label>
            <AttachSlot label="음성" value={draft.sessions[0].audio}
              onAttach={(p) => setDraft({ ...draft, sessions: [{ ...draft.sessions[0], audio: { path: p, addedAt: new Date().toISOString() } }] })} />
            <AttachSlot label="축어록" value={draft.sessions[0].transcriptWord} filters={TRANSCRIPT_DOC_FILTERS}
              onAttach={(p) => setDraft({ ...draft, sessions: [{ ...draft.sessions[0], transcriptWord: { path: p, addedAt: new Date().toISOString() } }] })} />
            <AttachSlot label="분석" value={draft.sessions[0].analysis}
              onAttach={(p) => setDraft({ ...draft, sessions: [{ ...draft.sessions[0], analysis: { path: p, addedAt: new Date().toISOString() } }] })} />
          </div>
          <p className="text-[11px] text-gray-400">
            심리검사 보고서·슈퍼비전 자료는 사례를 만든 뒤 언제든 필요할 때 추가할 수 있어요.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>취소</Button>
          <Button disabled={!draft.name.trim()} onClick={() => { onCreate(draft); onClose(); }}
            className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white">저장</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 서랍 관리 모달 — 생성/이름수정/삭제 ─────────────────────────────────
function DrawerManageDialog({
  open, onClose, drawers, onChange, caseCountOf,
}: {
  open: boolean; onClose: () => void; drawers: Drawer[];
  onChange: (next: Drawer[]) => void;
  caseCountOf: (drawerId: string) => number;
}) {
  const [newName, setNewName] = useState("");

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    if (drawers.some((d) => d.name === name)) { window.alert(`'${name}' 서랍이 이미 있어요.`); return; }
    onChange([...drawers, { id: uid(), name }]);
    setNewName("");
  };
  const rename = (id: string, name: string) =>
    onChange(drawers.map((d) => (d.id === id ? { ...d, name } : d)));
  const remove = (d: Drawer) => {
    const n = caseCountOf(d.id);
    const msg = n > 0
      ? `'${d.name}' 서랍을 지울까요? 안에 있던 사례 ${n}개는 삭제되지 않고 '미분류'로 이동해요.`
      : `'${d.name}' 서랍을 지울까요?`;
    if (window.confirm(msg)) onChange(drawers.filter((x) => x.id !== d.id));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="text-[#2d1f0e]">사례서랍 관리</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-[11px] text-gray-400">
            서랍 이름으로 사례를 카테고리별로 나눠 보관할 수 있어요. (예: 학교센터, 개인상담, 수련사례)
          </p>
          <div className="flex gap-1.5">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="새 서랍 이름" className="text-xs h-9" />
            <Button onClick={add} disabled={!newName.trim()} className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white h-9 text-xs shrink-0">
              <Plus className="w-3.5 h-3.5 mr-0.5" /> 만들기
            </Button>
          </div>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {drawers.length === 0 && <p className="text-xs text-gray-400 text-center py-4">아직 서랍이 없어요.</p>}
            {drawers.map((d) => (
              <div key={d.id} className="flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5 text-[#3a6a4a] shrink-0" />
                <input
                  value={d.name}
                  onChange={(e) => rename(d.id, e.target.value)}
                  className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]"
                />
                <span className="text-[10px] text-gray-400 shrink-0 w-10 text-right">{caseCountOf(d.id)}건</span>
                <button onClick={() => remove(d)} title="서랍 삭제"
                  className="shrink-0 p-1.5 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>닫기</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 기타자료 모달 — 내담자와 무관한 공용 자료(양식·교육자료 등) 연결 ──────
function MiscDocsDialog({
  open, onClose, docs, onChange, onOpenFile,
}: {
  open: boolean; onClose: () => void; docs: ExtraDoc[];
  onChange: (next: ExtraDoc[]) => void;
  onOpenFile: (label: string, path: string) => void;
}) {
  const add = async () => {
    const p = await caseDrawerAPI?.selectFile();
    if (!p) return;
    onChange([...docs, { id: uid(), date: new Date().toISOString().slice(0, 10), path: p }]);
  };
  const remove = (id: string) => {
    if (window.confirm("이 첨부를 없앨까요? (원본 파일은 지워지지 않아요)")) {
      onChange(docs.filter((d) => d.id !== id));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="text-[#2d1f0e]">기타자료</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-[11px] text-gray-400">
            특정 내담자에 속하지 않는 자료(보고서 양식, 교육자료, 참고문헌 등)를 연결해두고 언제든 열어볼 수 있어요. 파일은 복사되지 않고 경로만 연결돼요.
          </p>
          <Button onClick={add} variant="outline" className="w-full text-xs h-9 border-dashed">
            <Plus className="w-3.5 h-3.5 mr-1" /> 파일 추가
          </Button>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {docs.length === 0 && <p className="text-xs text-gray-400 text-center py-4">아직 없어요.</p>}
            {docs.map((d) => (
              <div key={d.id} className="flex items-center gap-0.5 rounded-md bg-white border border-gray-200 hover:bg-gray-50">
                <button onClick={() => onOpenFile("기타자료", d.path)}
                  className="flex-1 min-w-0 text-left text-xs pl-2.5 pr-1 py-2 text-gray-600 truncate">
                  {d.date} · {baseName(d.path)}
                </button>
                <button onClick={() => remove(d.id)} title="삭제"
                  className="shrink-0 pr-2 pl-1 py-2 text-gray-300 hover:text-red-500">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>닫기</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 최초 설정: 저장 폴더 선택 + 잠금 비밀번호 설정 ──────────────────────
function SetupScreen({ onDone, initialFolder }: { onDone: (settings: CaseSettings) => void; initialFolder?: string | null }) {
  const [folder, setFolder] = useState<string | null>(initialFolder ?? null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const pickFolder = async () => {
    const p = await caseDrawerAPI?.selectFolder();
    if (p) setFolder(p);
  };

  const submit = async () => {
    if (!folder) { setErr("사례서랍을 저장할 폴더를 먼저 선택해주세요."); return; }
    if (pw.length < 4) { setErr("비밀번호는 4자 이상으로 정해주세요."); return; }
    if (pw !== pw2) { setErr("비밀번호가 서로 달라요."); return; }
    setBusy(true);
    const salt = uid();
    const passwordHash = await sha256Hex(salt + pw);
    await caseDrawerAPI?.mkdir(folder);
    const settings: CaseSettings = { rootFolder: folder, passwordHash, passwordSalt: salt };
    await caseDrawerAPI?.setSettings(settings);
    setBusy(false);
    onDone(settings);
  };

  return (
    <div className="flex-1 flex items-center justify-center p-6" style={{ background: "#f7f5f2" }}>
      <div className="w-full max-w-md bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-[#3a6a4a]" />
          <h2 className="font-bold text-[#2d1f0e]">사례서랍 처음 설정</h2>
        </div>
        <p className="text-xs text-gray-500 leading-relaxed">
          사례 정리정보를 저장할 폴더를 골라주세요. 이 폴더 안에 사례별 하위 폴더가 자동으로 만들어져요.
          그 다음, 사례서랍을 열 때마다 물어볼 잠금 비밀번호를 정해주세요(파일 자체를 암호화하는 건 아니고,
          이 앱 안에서 사례서랍에 들어갈 때 여는 열쇠예요 — 실제 파일 보안은 사용자님이 컴퓨터에 걸어두신
          디스크/폴더 암호화가 담당해요).
        </p>
        <div className="space-y-1">
          <Label className="text-xs">저장 폴더</Label>
          <button onClick={pickFolder}
            className="w-full text-left text-xs px-2.5 py-2 rounded-md border border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-600 truncate">
            {folder || "폴더 선택..."}
          </button>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">잠금 비밀번호</Label>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">비밀번호 확인</Label>
          <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        {err && <p className="text-xs text-red-500">{err}</p>}
        <Button disabled={busy} onClick={submit} className="w-full bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white">
          설정 완료
        </Button>
      </div>
    </div>
  );
}

// ── 잠금 화면: 비밀번호 입력 ────────────────────────────────────────────
function LockScreen({
  settings, onUnlock, onReset,
}: {
  settings: CaseSettings; onUnlock: () => void; onReset: () => void;
}) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [showReset, setShowReset] = useState(false);

  const submit = async () => {
    const hash = await sha256Hex((settings.passwordSalt || "") + pw);
    if (hash === settings.passwordHash) { onUnlock(); return; }
    setErr("비밀번호가 맞지 않아요.");
  };

  return (
    <div className="flex-1 flex items-center justify-center p-6" style={{ background: "#f7f5f2" }}>
      <div className="w-full max-w-sm bg-white rounded-xl border border-gray-200 p-6 space-y-4 text-center">
        <Lock className="w-8 h-8 text-[#3a6a4a] mx-auto" />
        <h2 className="font-bold text-[#2d1f0e]">사례서랍이 잠겨 있어요</h2>
        <p className="text-xs text-gray-500">비밀번호를 입력하면 열려요.</p>
        <Input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()} className="text-center" />
        {err && <p className="text-xs text-red-500">{err}</p>}
        <Button onClick={submit} className="w-full bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white">열기</Button>
        {!showReset ? (
          <button onClick={() => setShowReset(true)} className="text-[11px] text-gray-400 hover:text-gray-600 underline">
            비밀번호를 잊으셨나요?
          </button>
        ) : (
          <div className="text-xs text-gray-500 space-y-2 bg-gray-50 rounded-lg p-3">
            <p>비밀번호를 새로 정할 수 있어요. 실제 파일은 암호화된 게 아니라서 데이터 손실 없이 재설정돼요.</p>
            <Button variant="outline" className="w-full text-xs" onClick={onReset}>비밀번호 재설정</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 사례연구 책상 ─────────────────────────────────────────────────────
// 자료창(종류별 탭 + 항목 선택 + 문서 뷰어)이 기본으로 전체 폭을 쓰고,
// "보고서 작성"을 누르면 절반으로 줄면서 오른쪽에 작성칸이 생긴다.
// 작성칸의 알맹이(양식 등록·자동입력·AI초안·hwpx 저장)는 docsPlan/보고서작성책상/ 설계대로 후속 구현.
type DeskTab = "transcript" | "analysis" | "genogram" | "psych" | "supervision" | "misc";
const DESK_TABS: { key: DeskTab; label: string }[] = [
  { key: "transcript", label: "축어록" },
  { key: "analysis", label: "분석" },
  { key: "genogram", label: "가계도" },
  { key: "psych", label: "심리검사" },
  { key: "supervision", label: "슈퍼비전" },
  { key: "misc", label: "기타자료" },
];

function deskItems(data: CaseRecord, tab: DeskTab, miscDocs: ExtraDoc[]): { label: string; path: string }[] {
  switch (tab) {
    case "transcript": return data.sessions.filter((s) => s.transcriptWord).map((s) => ({ label: `${s.no}회차 축어록`, path: s.transcriptWord!.path }));
    case "analysis":   return data.sessions.filter((s) => s.analysis).map((s) => ({ label: `${s.no}회차 분석`, path: s.analysis!.path }));
    case "genogram":   return data.genogram ? [{ label: "가계도", path: data.genogram.path }] : [];
    case "psych":      return data.psychTests.map((d) => ({ label: `심리검사 · ${d.date}`, path: d.path }));
    case "supervision":return data.supervisions.map((d) => ({ label: `슈퍼비전 · ${d.date}`, path: d.path }));
    case "misc":       return miscDocs.map((d) => ({ label: `기타자료 · ${d.date}`, path: d.path }));
  }
}

// 섹션별 작성 길잡이 (2026-07-09 사용자 제공) — 양식 분석에서 같은 제목이 나오면 그 칸에 표시
const OBSERVER_GUIDES: Record<string, string[]> = {
  "내담자 이해의 확장": [
    "내방경위를 한두 줄로 작성",
    "이전 상담 경험 (어디서, 어떤 문제로, 얼마 정도 상담을 받았는지)",
    "주호소 문제를 쓰고, 어떤 연유로 이런 주호소가 생겼는지 작성",
    "문제 양상 작성",
    "주호소에 대한 내담자의 원트(바람)가 나온 후 치료적 방향 작성 (그걸 위해 상담에서는 어떻게 하겠다)",
    "제일 마지막에 보호요인·위험요인·강점 쓰기 (확실하지 않으면 \"~일 가능성이 있다, 추후 탐색하겠다\" 식으로)",
    "주호소가 명료하지 않다면 이론을 적용하여 작성",
  ],
};

function ReportDesk({
  data, initialTab, onBack, miscDocs, caseDir,
}: {
  data: CaseRecord; initialTab?: DeskTab; onBack: () => void; miscDocs: ExtraDoc[]; caseDir: string;
}) {
  // 자료 종류 탭을 토글하면 그 종류의 창이 열리고/닫힌다 — 여러 개 동시에 분할로 볼 수 있음.
  // 각 창은 자기 항목 선택(selectedPath)과 스크롤을 따로 가진다.
  const [panes, setPanes] = useState<{ tab: DeskTab; selectedPath: string | null }[]>(
    [{ tab: initialTab ?? "transcript", selectedPath: null }]
  );
  const [showReport, setShowReport] = useState(false);
  // 창 제목 줄을 클릭하면 그 창만 크게(전체) 보고, 나머지는 접힌 띠로 둔다.
  // 다시 클릭하면 분할 배치로 복귀.
  const [focusedTab, setFocusedTab] = useState<DeskTab | null>(null);

  const togglePane = (t: DeskTab) => {
    setPanes((prev) =>
      prev.some((p) => p.tab === t)
        ? prev.filter((p) => p.tab !== t)
        : [...prev, { tab: t, selectedPath: null }]
    );
    if (focusedTab === t) setFocusedTab(null);
  };
  const closePane = (t: DeskTab) => {
    setPanes((prev) => prev.filter((p) => p.tab !== t));
    if (focusedTab === t) setFocusedTab(null);
  };
  const selectInPane = (t: DeskTab, path: string) =>
    setPanes((prev) => prev.map((p) => (p.tab === t ? { ...p, selectedPath: path } : p)));

  // 크게 보기 중이면 그 창 하나만, 아니면 열린 창 전부
  const visiblePanes = focusedTab ? panes.filter((p) => p.tab === focusedTab) : panes;
  const collapsedPanes = focusedTab ? panes.filter((p) => p.tab !== focusedTab) : [];
  // 열린 창 개수에 맞춰 배치: 1개=한 칸, 2개=좌우/상하(사용자 선택), 3개 이상=2열 격자
  const paneGridClass = visiblePanes.length <= 1 ? "grid-cols-1" : "grid-cols-2";
  // 창 2개일 때 배치 방향 — 좌우(row) 또는 상하(col), 경계선 드래그로 비율 조절
  const [paneLayout, setPaneLayout] = useState<"row" | "col">("row");
  const [paneSplit, setPaneSplit] = useState(50); // 첫 창의 비율 %
  const paneAreaRef = useRef<HTMLDivElement>(null);

  // 공용 경계선 드래그 — 방향(가로/세로)에 따라 마우스 위치를 %로 환산
  const dragDivider = (
    e: React.MouseEvent, ref: React.RefObject<HTMLDivElement>,
    horizontal: boolean, set: (pct: number) => void,
  ) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = horizontal
        ? ((ev.clientX - rect.left) / rect.width) * 100
        : ((ev.clientY - rect.top) / rect.height) * 100;
      if (isFinite(pct)) set(Math.min(80, Math.max(20, pct)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // 보고서 작성 모드에서 자료창↔작성창 경계를 마우스로 끌어 비율 조절
  const splitRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState(50);
  const startDivider = (e: React.MouseEvent) => dragDivider(e, splitRef, true, setLeftPct);

  // ── 보고서 작성 폼 — 양식(hwpx)을 먼저 선택하면 그 양식을 분석해 작성칸이 생긴다 ──
  const [obsFormPath, setObsFormPath] = useState<string>(() => localStorage.getItem("gb_observer_form") || "");
  const [obsSectionList, setObsSectionList] = useState<{ title: string; guide: string }[] | null>(null); // 양식에서 찾은 섹션들
  const [obsFormType, setObsFormType] = useState<"paragraph" | "table">("paragraph"); // 문단형(참관자) | 표형(심리평가)
  const [obsHeaderLabels, setObsHeaderLabels] = useState<string[]>([]);        // 표형 머리표 라벨들
  const [obsHeader, setObsHeader] = useState<Record<string, string>>({});      // 표형 머리표 입력값
  const [obsHasHeader, setObsHasHeader] = useState(false);                     // 문단형: 참관일/소속/이름 머리줄 유무
  const [obsFormError, setObsFormError] = useState("");
  const [obsDate, setObsDate] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  });
  const [obsAffil, setObsAffil] = useState<string>(() => localStorage.getItem("gb_observer_affil") || "");
  const [obsName, setObsName] = useState<string>(() => localStorage.getItem("gb_user") || "");
  const [obsSections, setObsSections] = useState<Record<string, string>>({});
  const [obsSaving, setObsSaving] = useState(false);
  const [obsResult, setObsResult] = useState<{ ok: boolean; msg: string; path?: string } | null>(null);

  // 양식 분석 → 작성칸 목록 생성
  const loadObsForm = async (path: string) => {
    setObsFormError(""); setObsSectionList(null);
    try {
      const r = await fetch("http://127.0.0.1:5577/api/report/template-sections", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form_path: path }),
      });
      const d = await r.json();
      if (d.ok) {
        setObsSectionList(d.sections);
        setObsFormType(d.type === "table" ? "table" : "paragraph");
        setObsHeaderLabels(d.header_labels || []);
        setObsHasHeader(!!d.has_header);
        setObsSections({}); setObsHeader({});
      }
      else setObsFormError(d.error || "양식을 분석하지 못했어요.");
    } catch { setObsFormError("서버에 연결할 수 없어요."); }
  };

  // 이전에 쓰던 양식이 저장돼 있으면 자동으로 불러옴
  useEffect(() => {
    if (showReport && obsFormPath && obsSectionList === null && !obsFormError) loadObsForm(obsFormPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showReport]);

  const pickObsForm = async () => {
    const p = await caseDrawerAPI?.selectFile([{ name: "한글 양식 (hwpx)", extensions: ["hwpx"] }]);
    if (p) {
      setObsFormPath(p);
      localStorage.setItem("gb_observer_form", p);
      await loadObsForm(p);
    }
  };

  const saveObserverReport = async () => {
    if (!obsFormPath || !obsSectionList) { setObsResult({ ok: false, msg: "먼저 보고서 양식(hwpx)을 선택해주세요." }); return; }
    if (obsFormType === "paragraph" && obsHasHeader && !obsName.trim()) { setObsResult({ ok: false, msg: "이름을 입력해주세요." }); return; }
    setObsSaving(true); setObsResult(null);
    localStorage.setItem("gb_observer_affil", obsAffil);
    // 파일명: 양식 이름의 "년월일"→날짜, "(이름)"→작성자 치환 (예: 20260709 참관자보고서(홍길동).hwpx)
    const dateCompact = obsDate.replace(/\./g, "").trim();
    let fileName = baseName(obsFormPath);
    if (fileName.includes("년월일") || fileName.includes("(이름)")) {
      fileName = fileName.replace("년월일", `${dateCompact} `).replace("(이름)", `(${obsName.trim()})`);
    } else {
      fileName = `${dateCompact} ${fileName.replace(/\.hwpx$/i, "")}(${obsName.trim() || data.name}).hwpx`;
    }
    if (!/\.hwpx$/i.test(fileName)) fileName += ".hwpx";
    const outPath = joinPath(caseDir, "보고서", fileName);
    try {
      const r = await fetch("http://127.0.0.1:5577/api/report/observer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          form_path: obsFormPath, out_path: outPath,
          date: obsDate, affiliation: obsAffil, name: obsName,
          header: obsHeader, sections: obsSections,
        }),
      });
      const d = await r.json();
      if (d.ok) setObsResult({ ok: true, msg: "보고서가 저장됐어요.", path: d.path });
      else setObsResult({ ok: false, msg: d.error || "저장에 실패했어요." });
    } catch {
      setObsResult({ ok: false, msg: "서버에 연결할 수 없어요." });
    } finally { setObsSaving(false); }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "#f7f5f2" }}>
      {/* 상단 바 */}
      <div className="flex items-center gap-3 px-5 py-3 bg-white border-b border-gray-200">
        <button onClick={onBack}
          className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1.5 rounded-md hover:bg-gray-100">
          ← 사례서랍
        </button>
        <div className="w-px h-5 bg-gray-200" />
        <ClipboardList className="w-4 h-4 text-[#3a6a4a]" />
        <span className="font-bold text-sm text-[#2d1f0e]">{data.name || "(이름 없음)"} 님 · 사례연구 책상</span>
        <span className="text-[11px] text-gray-400">총 {data.sessions.length}회차</span>
        {/* 자료 종류 토글 — 누르면 창이 열리고, 다시 누르면 닫힘 */}
        <div className="flex items-center gap-1 ml-3 overflow-x-auto">
          {DESK_TABS.map((t) => {
            const active = panes.some((p) => p.tab === t.key);
            return (
              <button key={t.key} onClick={() => togglePane(t.key)}
                className={`shrink-0 text-[11px] font-medium px-3 py-1.5 rounded-full border transition-colors
                  ${active ? "bg-[#f0f7f2] border-[#a8d8a8] text-[#2d7a3a]" : "bg-white border-gray-200 text-gray-400 hover:text-gray-600"}`}>
                {t.label}
              </button>
            );
          })}
        </div>
        <button onClick={() => setShowReport((v) => !v)}
          className={`ml-auto shrink-0 flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 rounded-lg transition-colors
            ${showReport
              ? "bg-gray-100 text-gray-600 hover:bg-gray-200"
              : "bg-[#3a6a4a] text-white hover:bg-[#2d5a3a]"}`}>
          {showReport ? "보고서 닫기" : <><Pencil className="w-3.5 h-3.5" /> 보고서 작성</>}
        </button>
      </div>

      {/* 자료 영역 (기본 전체 폭) ↔ 보고서 작성 시 절반 분할 */}
      <div ref={splitRef} className="flex-1 flex p-4 min-h-0">
        {/* 자료 창들 — 열린 개수만큼 분할 배치, 제목 줄 클릭 = 그 창만 크게/복귀 */}
        <div className="flex flex-col gap-2 min-h-0"
          style={showReport ? { width: `${leftPct}%` } : { width: "100%" }}>
          {/* 크게 보기 중일 때 나머지 창들은 접힌 띠로 — 클릭하면 그 창으로 전환 */}
          {collapsedPanes.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap shrink-0">
              {collapsedPanes.map((p) => {
                const meta = DESK_TABS.find((t) => t.key === p.tab)!;
                return (
                  <button key={p.tab} onClick={() => setFocusedTab(p.tab)}
                    title="클릭하면 이 창을 크게 봐요"
                    className="text-[11px] font-medium px-3 py-1.5 rounded-full bg-white border border-gray-200 text-gray-500 hover:text-[#2d7a3a] hover:border-[#a8d8a8] shadow-sm">
                    ▸ {meta.label}
                  </button>
                );
              })}
              <button onClick={() => setFocusedTab(null)}
                className="text-[11px] px-3 py-1.5 rounded-full border border-dashed border-gray-300 text-gray-400 hover:text-gray-600">
                ⊞ 분할로 보기
              </button>
            </div>
          )}
          {(() => {
            // 창 하나 렌더링 (분할·격자 어느 배치에서든 재사용)
            const renderPane = (pane: { tab: DeskTab; selectedPath: string | null }) => {
              const meta = DESK_TABS.find((t) => t.key === pane.tab)!;
              const items = deskItems(data, pane.tab, miscDocs);
              const current = items.find((it) => it.path === pane.selectedPath) ?? items[0] ?? null;
              const isFocused = focusedTab === pane.tab;
              return (
                <div key={pane.tab} className="w-full h-full flex flex-col min-h-0 min-w-0 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                  <div
                    onClick={() => setFocusedTab(isFocused ? null : pane.tab)}
                    title={isFocused ? "클릭하면 분할 배치로 돌아가요" : "클릭하면 이 창만 크게 봐요"}
                    className="flex items-center gap-1.5 px-3 py-2 border-b border-gray-100 bg-[#f0f7f2]/50 cursor-pointer select-none hover:bg-[#e0f0e8]/60">
                    <span className="shrink-0 text-[11px] font-bold text-[#2d7a3a]">
                      {isFocused ? "▾ " : ""}{meta.label}
                    </span>
                    {items.length > 0 && (
                      <select
                        value={current?.path ?? ""}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => selectInPane(pane.tab, e.target.value)}
                        className="flex-1 min-w-0 text-[11px] border border-gray-200 bg-white rounded-full px-2.5 py-1 text-gray-600 truncate">
                        {items.map((it) => (
                          <option key={it.path + it.label} value={it.path}>{it.label} · {baseName(it.path)}</option>
                        ))}
                      </select>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); closePane(pane.tab); }} title="창 닫기"
                      className="ml-auto shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 text-sm leading-none">
                      ✕
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3">
                    {!current ? (
                      <p className="text-xs text-gray-400 text-center py-8">
                        이 종류의 자료가 아직 없어요.<br />사례서랍에서 첨부하면 여기에 나타나요.
                      </p>
                    ) : (
                      <FileInlineViewer label={current.label} path={current.path} />
                    )}
                  </div>
                </div>
              );
            };

            if (panes.length === 0) {
              return (
                <div className="flex-1 flex items-center justify-center bg-white rounded-2xl border border-gray-200">
                  <p className="text-xs text-gray-400 text-center">위의 자료 종류 버튼을 눌러 창을 열어보세요.</p>
                </div>
              );
            }

            // 창 2개 = 좌우/상하 배치 + 경계선 드래그로 비율 조절
            // 배치 전환 버튼을 자료창 영역 안에 둬서(상단 바 X) 보고서 모드에서도 항상 보이게 함
            if (visiblePanes.length === 2) {
              const horizontal = paneLayout === "row";
              return (
                <div className="flex-1 flex flex-col min-h-0 gap-1.5">
                  <div className="shrink-0 flex items-center gap-1.5">
                    <button onClick={() => setPaneLayout("row")}
                      className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors
                        ${horizontal ? "bg-[#3a6a4a] border-[#3a6a4a] text-white" : "bg-white border-gray-200 text-gray-400 hover:text-gray-600"}`}>
                      ◫ 좌우
                    </button>
                    <button onClick={() => setPaneLayout("col")}
                      className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors
                        ${!horizontal ? "bg-[#3a6a4a] border-[#3a6a4a] text-white" : "bg-white border-gray-200 text-gray-400 hover:text-gray-600"}`}>
                      ⬓ 상하
                    </button>
                    <span className="text-[10px] text-gray-400">가운데 경계선을 끌면 크기가 바뀌어요</span>
                  </div>
                  <div ref={paneAreaRef} className={`flex-1 flex min-h-0 ${horizontal ? "flex-row" : "flex-col"}`}>
                    <div className="flex min-h-0 min-w-0" style={horizontal ? { width: `${paneSplit}%` } : { height: `${paneSplit}%` }}>
                      {renderPane(visiblePanes[0])}
                    </div>
                    <div
                      onMouseDown={(e) => dragDivider(e, paneAreaRef, horizontal, setPaneSplit)}
                      title="끌어서 크기 조절"
                      className={`shrink-0 flex items-center justify-center group ${horizontal ? "w-3 cursor-col-resize" : "h-3 cursor-row-resize"}`}>
                      <div className={`rounded-full bg-gray-300 group-hover:bg-[#3a6a4a] transition-colors ${horizontal ? "w-1 h-12" : "h-1 w-12"}`} />
                    </div>
                    <div className="flex-1 flex min-h-0 min-w-0">
                      {renderPane(visiblePanes[1])}
                    </div>
                  </div>
                </div>
              );
            }

            // 1개 또는 3개 이상 = 격자 배치
            return (
              <div className={`flex-1 grid gap-3 min-h-0 ${paneGridClass}`} style={{ gridAutoRows: "minmax(0, 1fr)" }}>
                {visiblePanes.map(renderPane)}
              </div>
            );
          })()}
        </div>

        {/* 자료창↔작성창 크기 조절 경계선 — 마우스로 끌면 비율이 바뀜 */}
        {showReport && (
          <div onMouseDown={startDivider} title="끌어서 크기 조절"
            className="shrink-0 w-4 mx-0 cursor-col-resize flex items-center justify-center group">
            <div className="w-1 h-16 rounded-full bg-gray-300 group-hover:bg-[#3a6a4a] transition-colors" />
          </div>
        )}

        {/* 보고서 작성칸 — 양식(hwpx)을 먼저 선택하면 그 양식에 맞는 작성칸이 생김 */}
        {showReport && (
          <div className="flex-1 flex flex-col min-h-0 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-100">
              <span className="shrink-0 text-xs font-bold text-[#2d1f0e]">보고서 작성</span>
              {obsFormPath && obsSectionList && (
                <button onClick={pickObsForm}
                  className="min-w-0 text-[11px] px-2.5 py-1 rounded-full border border-gray-200 text-gray-500 hover:text-[#2d7a3a] hover:border-[#a8d8a8] truncate"
                  title="다른 양식으로 바꾸기">
                  양식: {baseName(obsFormPath)}
                </button>
              )}
            </div>

            {/* 양식 미선택/분석 전 → 선택 화면 */}
            {(!obsFormPath || !obsSectionList) ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
                <ClipboardList className="w-10 h-10 text-gray-200" />
                <p className="text-sm text-gray-500 leading-relaxed">
                  보고서 양식(hwpx)을 선택하면<br />그 양식에 맞는 작성칸이 자동으로 생겨요.
                </p>
                {obsFormError && <p className="text-xs text-red-500">{obsFormError}</p>}
                <Button onClick={pickObsForm} className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white text-xs h-9">
                  <Plus className="w-3.5 h-3.5 mr-1" /> 보고서 양식(hwpx) 선택
                </Button>
                {obsFormPath && !obsFormError && <p className="text-[11px] text-gray-400">양식 분석 중...</p>}
              </div>
            ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {/* 문단형 머리줄 — 양식에 참관일 줄이 있을 때만 */}
              {obsFormType === "paragraph" && obsHasHeader && (
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">참관일</label>
                  <input value={obsDate} onChange={(e) => setObsDate(e.target.value)} placeholder="2026.07.09"
                    className="w-full text-xs px-2.5 py-2 rounded-md border border-gray-200 focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]" />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">소속</label>
                  <input value={obsAffil} onChange={(e) => setObsAffil(e.target.value)}
                    className="w-full text-xs px-2.5 py-2 rounded-md border border-gray-200 focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]" />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">이름</label>
                  <input value={obsName} onChange={(e) => setObsName(e.target.value)}
                    className="w-full text-xs px-2.5 py-2 rounded-md border border-gray-200 focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]" />
                </div>
              </div>
              )}
              {/* 표형 머리표 — 양식에서 찾은 라벨 그대로 (평가기관·슈퍼바이저 등) */}
              {obsFormType === "table" && obsHeaderLabels.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {obsHeaderLabels.map((lbl) => (
                    <div key={lbl}>
                      <label className="block text-[11px] text-gray-500 mb-1">{lbl}</label>
                      <input value={obsHeader[lbl] ?? ""}
                        onChange={(e) => setObsHeader((prev) => ({ ...prev, [lbl]: e.target.value }))}
                        className="w-full text-xs px-2.5 py-2 rounded-md border border-gray-200 focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]" />
                    </div>
                  ))}
                </div>
              )}
              {/* 섹션별 작성칸 — 양식에서 찾은 제목 그대로, 가이드(양식 안내문/내장 길잡이)는 접이식 */}
              {obsSectionList.map((sec) => (
                <div key={sec.title}>
                  <label className="block text-[11px] font-bold text-[#5a4630] mb-1">{sec.title}</label>
                  {(sec.guide || OBSERVER_GUIDES[sec.title]) && (
                    <details className="mb-1.5 rounded-md border border-[#a8d8a8]/60 bg-[#f0f7f2]/60">
                      <summary className="cursor-pointer select-none text-[11px] font-medium text-[#2d7a3a] px-2.5 py-1.5">
                        작성 길잡이 (보면서 작성하세요)
                      </summary>
                      {sec.guide ? (
                        <p className="px-3 pb-2 text-[11px] leading-relaxed text-gray-600 whitespace-pre-wrap">{sec.guide}</p>
                      ) : (
                        <ol className="px-3 pb-2 space-y-1">
                          {OBSERVER_GUIDES[sec.title].map((g, i) => (
                            <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-gray-600">
                              <span className="shrink-0 font-bold text-[#2d7a3a]">{i + 1}.</span>{g}
                            </li>
                          ))}
                        </ol>
                      )}
                    </details>
                  )}
                  <textarea
                    value={obsSections[sec.title] ?? ""}
                    onChange={(e) => setObsSections((prev) => ({ ...prev, [sec.title]: e.target.value }))}
                    rows={sec.guide || OBSERVER_GUIDES[sec.title] ? 6 : 4}
                    placeholder={obsFormType === "table"
                      ? "왼쪽 자료를 보면서 작성하세요. 저장하면 이 항목 칸의 안내문이 작성 내용으로 바뀌어요. 비워두면 안내문이 그대로 남아요."
                      : "왼쪽 자료를 보면서 작성하세요. 저장하면 양식의 이 제목 아래에 그대로 들어가요."}
                    className="w-full text-xs leading-relaxed px-2.5 py-2 rounded-md border border-gray-200 resize-y focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]" />
                </div>
              ))}
              {obsResult && (
                <div className={`text-xs rounded-md px-3 py-2 ${obsResult.ok ? "bg-[#f0f7f2] text-[#2d7a3a] border border-[#a8d8a8]" : "bg-red-50 text-red-600 border border-red-200"}`}>
                  {obsResult.msg}
                  {obsResult.ok && obsResult.path && (
                    <button onClick={() => caseDrawerAPI?.openExternal(obsResult.path!)}
                      className="ml-2 underline font-bold">한글로 열기</button>
                  )}
                </div>
              )}
            </div>
            )}
            {obsFormPath && obsSectionList && (
              <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-t border-gray-100">
                <span className="text-[10px] text-gray-400 truncate">저장 위치: 사례 폴더\보고서\</span>
                <Button onClick={saveObserverReport} disabled={obsSaving}
                  className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white text-xs h-8">
                  {obsSaving ? "저장 중..." : "보고서 완성 (hwpx 저장)"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 메인 ────────────────────────────────────────────────────────────
export default function CaseDrawer() {
  const [settings, setSettings] = useState<CaseSettings | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [query, setQuery] = useState("");
  const [previewFile, setPreviewFile] = useState<{ label: string; path: string } | null>(null);
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [desk, setDesk] = useState<{ caseId: string; tab?: DeskTab } | null>(null);
  // 서랍(카테고리)과 기타자료 — 사례 루트폴더에 실제 파일로 저장
  const [drawers, setDrawers] = useState<Drawer[]>([]);
  const [activeDrawer, setActiveDrawer] = useState<string>("all"); // "all" | "none"(미분류) | drawerId
  const [showDrawerManage, setShowDrawerManage] = useState(false);
  const [miscDocs, setMiscDocs] = useState<ExtraDoc[]>([]);
  const [showMisc, setShowMisc] = useState(false);
  const [extrasLoaded, setExtrasLoaded] = useState(false);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  useEffect(() => {
    caseDrawerAPI?.getSettings().then(setSettings);
  }, []);

  const loadCasesFromFolder = async (rootFolder: string) => {
    const dirs = await caseDrawerAPI!.listDirs(rootFolder);
    const loadedCases: CaseRecord[] = [];
    for (const dir of dirs) {
      const infoPath = joinPath(rootFolder, dir, "_사례정보.json");
      const text = await caseDrawerAPI!.readText(infoPath);
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        loadedCases.push({ ...parsed, folderName: dir, basicInfo: parsed.basicInfo || emptyBasicInfo() });
      } catch { /* 손상된 폴더는 건너뜀 */ }
    }
    setCases(loadedCases);
    setLoaded(true);
  };

  // 서랍 목록·기타자료 불러오기 (없으면 빈 상태로 시작 — 구버전 데이터와 호환)
  const loadExtras = async (rootFolder: string) => {
    try {
      const t = await caseDrawerAPI!.readText(joinPath(rootFolder, "_사례서랍.json"));
      if (t) setDrawers(JSON.parse(t).drawers ?? []);
    } catch { /* 없거나 손상 → 빈 목록 */ }
    try {
      const t = await caseDrawerAPI!.readText(joinPath(rootFolder, "_기타자료.json"));
      if (t) setMiscDocs(JSON.parse(t).docs ?? []);
    } catch { /* 없거나 손상 → 빈 목록 */ }
    setExtrasLoaded(true);
  };

  useEffect(() => {
    if (unlocked && settings?.rootFolder) {
      loadCasesFromFolder(settings.rootFolder);
      loadExtras(settings.rootFolder);
    }
  }, [unlocked, settings?.rootFolder]);

  // 서랍·기타자료 변경 시 저장
  useEffect(() => {
    if (!extrasLoaded || !settings?.rootFolder) return;
    caseDrawerAPI?.writeText(joinPath(settings.rootFolder, "_사례서랍.json"), JSON.stringify({ drawers }, null, 2));
  }, [drawers, extrasLoaded, settings?.rootFolder]);
  useEffect(() => {
    if (!extrasLoaded || !settings?.rootFolder) return;
    caseDrawerAPI?.writeText(joinPath(settings.rootFolder, "_기타자료.json"), JSON.stringify({ docs: miscDocs }, null, 2));
  }, [miscDocs, extrasLoaded, settings?.rootFolder]);

  // 서랍 목록 변경(삭제) 시 사라진 서랍을 가리키는 사례는 미분류로
  const changeDrawers = (next: Drawer[]) => {
    const ids = new Set(next.map((d) => d.id));
    setDrawers(next);
    setCases((prev) => prev.map((c) => (c.drawer && !ids.has(c.drawer) ? { ...c, drawer: null } : c)));
    if (activeDrawer !== "all" && activeDrawer !== "none" && !ids.has(activeDrawer)) setActiveDrawer("all");
  };

  // 사례 목록이 바뀔 때마다 각 사례를 자기 하위 폴더의 _사례정보.json 으로 저장
  useEffect(() => {
    if (!loaded || !settings?.rootFolder) return;
    (async () => {
      for (const c of cases) {
        const dir = joinPath(settings.rootFolder!, c.folderName);
        await caseDrawerAPI?.mkdir(dir);
        await caseDrawerAPI?.writeText(joinPath(dir, "_사례정보.json"), JSON.stringify(c, null, 2));
      }
    })();
  }, [cases, loaded, settings?.rootFolder]);

  const updateCase = (next: CaseRecord) => setCases((prev) => prev.map((c) => (c.id === next.id ? next : c)));

  const deleteCase = (id: string, name: string) => {
    if (!window.confirm(`'${name || "(이름 없음)"}' 사례를 사례서랍에서 완전히 삭제할까요?\n실제 폴더와 그 안의 정리정보 파일은 컴퓨터에 그대로 남아요(되돌리려면 탐색기에서 직접 지워야 해요). 되돌릴 수 없어요.`)) return;
    setCases((prev) => prev.filter((c) => c.id !== id));
    if (openId === id) setOpenId(null);
  };

  const createCase = (draft: CaseRecord) => {
    const existingNames = new Set(cases.map((c) => c.name));
    let finalName = draft.name;
    if (existingNames.has(finalName)) {
      let n = 2;
      while (existingNames.has(`${draft.name} (${n})`)) n++;
      finalName = `${draft.name} (${n})`;
      showToast(`이미 같은 이름의 내담자가 있어 '${finalName}'(으)로 저장했어요.`);
    }
    const existingFolders = new Set(cases.map((c) => c.folderName));
    let folderName = `${sanitizeForFolder(finalName)}_${draft.startDate}`;
    if (existingFolders.has(folderName)) {
      let n = 2;
      while (existingFolders.has(`${folderName}_${n}`)) n++;
      folderName = `${folderName}_${n}`;
    }
    setCases((prev) => [...prev, { ...draft, name: finalName, folderName }]);
  };

  const editingCase = cases.find((c) => c.id === editingCaseId) || null;

  const filtered = useMemo(() => {
    const q = query.trim();
    let list = cases;
    if (activeDrawer === "none") list = list.filter((c) => !c.drawer);
    else if (activeDrawer !== "all") list = list.filter((c) => c.drawer === activeDrawer);
    if (!q) return list;
    return list.filter((c) =>
      c.name.includes(q) ||
      c.startDate.includes(q) ||
      c.sessions.some((s) => s.date.includes(q) || String(s.no) === q || `${s.no}회차`.includes(q))
    );
  }, [cases, query, activeDrawer]);

  if (settings === null) return null; // 설정 로딩 중

  if (!settings.rootFolder || !settings.passwordHash) {
    return (
      <SetupScreen
        initialFolder={settings.rootFolder}
        onDone={(s) => { setSettings(s); setUnlocked(true); }}
      />
    );
  }

  if (!unlocked) {
    return (
      <LockScreen
        settings={settings}
        onUnlock={() => setUnlocked(true)}
        onReset={() => setSettings({ ...settings, passwordHash: null, passwordSalt: null })}
      />
    );
  }

  // 사례연구 책상 화면 (자료 열람 + 보고서 작성)
  const deskCase = desk ? cases.find((c) => c.id === desk.caseId) : null;
  if (desk && deskCase) {
    return (
      <ReportDesk data={deskCase} initialTab={desk.tab} onBack={() => setDesk(null)} miscDocs={miscDocs}
        caseDir={joinPath(settings.rootFolder!, deskCase.folderName)} />
    );
  }

  return (
    <div className="flex-1 overflow-auto p-5 space-y-3" style={{ background: "#f7f5f2" }}>
      <div className="flex items-center gap-2 sticky top-0 bg-[#f7f5f2] pb-2 z-10">
        <div className="relative flex-1 max-w-sm" data-tour="case-search">
          <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="내담자명 · 상담기간 · 회차로 검색"
            className="w-full text-xs pl-8 pr-3 py-2 rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-[#a8d8a8]"
          />
        </div>
        <Button onClick={() => setShowNew(true)} data-tour="case-new" className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white text-xs h-9">
          <Plus className="w-3.5 h-3.5 mr-1" /> 새 사례 만들기
        </Button>
        <Button onClick={() => setShowMisc(true)} variant="outline" className="text-xs h-9 border-gray-200 text-gray-600">
          <FolderOpen className="w-3.5 h-3.5 mr-1" /> 기타자료
        </Button>
        <button onClick={() => setUnlocked(false)} title="지금 잠그기" data-tour="case-lock"
          className="shrink-0 p-2 rounded-lg border border-gray-200 text-gray-400 hover:text-gray-600 hover:bg-gray-100">
          <Lock className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 서랍(카테고리) 필터 바 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button onClick={() => setActiveDrawer("all")}
          className={`text-[11px] font-medium px-3 py-1.5 rounded-full border transition-colors
            ${activeDrawer === "all" ? "bg-[#3a6a4a] border-[#3a6a4a] text-white" : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"}`}>
          사례서랍 <span className="opacity-70">{cases.length}</span>
        </button>
        {drawers.map((d) => {
          const n = cases.filter((c) => c.drawer === d.id).length;
          return (
            <button key={d.id} onClick={() => setActiveDrawer(d.id)}
              className={`text-[11px] font-medium px-3 py-1.5 rounded-full border transition-colors
                ${activeDrawer === d.id ? "bg-[#3a6a4a] border-[#3a6a4a] text-white" : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"}`}>
              {d.name} <span className="opacity-70">{n}</span>
            </button>
          );
        })}
        {drawers.length > 0 && cases.some((c) => !c.drawer) && (
          <button onClick={() => setActiveDrawer("none")}
            className={`text-[11px] font-medium px-3 py-1.5 rounded-full border transition-colors
              ${activeDrawer === "none" ? "bg-[#3a6a4a] border-[#3a6a4a] text-white" : "bg-white border-gray-200 text-gray-400 hover:bg-gray-50"}`}>
            미분류 <span className="opacity-70">{cases.filter((c) => !c.drawer).length}</span>
          </button>
        )}
        <button onClick={() => setShowDrawerManage(true)}
          className="flex items-center gap-1 text-[11px] font-bold px-3.5 py-1.5 rounded-full border border-[#a8d8a8] bg-[#f0f7f2] text-[#2d7a3a] hover:bg-[#e0f0e8] shadow-sm">
          <Pencil className="w-3 h-3" /> 서랍 관리
        </button>
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-10">
          {cases.length === 0 ? "아직 등록된 사례가 없어요. '새 사례 만들기'로 시작해보세요."
            : query.trim() ? "검색 결과가 없어요."
            : "이 서랍에 담긴 사례가 없어요. 사례 정보 수정에서 서랍을 지정할 수 있어요."}
        </p>
      )}

      <div className="space-y-2.5">
        {filtered.map((c) => (
          <CaseRow key={c.id} data={c} open={openId === c.id}
            onToggle={() => setOpenId(openId === c.id ? null : c.id)}
            onChange={updateCase}
            onOpenFile={(label, path) => setPreviewFile({ label, path })}
            onDelete={() => deleteCase(c.id, c.name)}
            onEditInfo={() => setEditingCaseId(c.id)}
            onOpenDesk={(tab) => setDesk({ caseId: c.id, tab })} />
        ))}
      </div>

      <NewCaseDialog open={showNew} onClose={() => setShowNew(false)} onCreate={createCase} drawers={drawers} />
      <FilePreviewDialog file={previewFile} onClose={() => setPreviewFile(null)} />
      <EditCaseInfoDialog
        data={editingCase} open={!!editingCaseId} onClose={() => setEditingCaseId(null)} drawers={drawers}
        onSave={(name, startDate, labelColor, drawer) => {
          if (!editingCase) return;
          const dup = cases.some((c) => c.id !== editingCase.id && c.name === name);
          if (dup) { showToast(`'${name}' 이름을 가진 다른 내담자가 이미 있어요. 구분되게 이름을 다르게 적어주세요.`); return; }
          updateCase({ ...editingCase, name, startDate, labelColor, drawer });
        }}
      />
      <DrawerManageDialog
        open={showDrawerManage} onClose={() => setShowDrawerManage(false)}
        drawers={drawers} onChange={changeDrawers}
        caseCountOf={(id) => cases.filter((c) => c.drawer === id).length}
      />
      <MiscDocsDialog
        open={showMisc} onClose={() => setShowMisc(false)}
        docs={miscDocs} onChange={setMiscDocs}
        onOpenFile={(label, path) => setPreviewFile({ label, path })}
      />

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#2d1f0e] text-white text-xs px-4 py-2.5 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
