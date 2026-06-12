import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Play, Pause, Upload, Save, Settings,
  Cpu, ShieldCheck, Clock, SkipBack, SkipForward, Undo2, BookOpen, Pencil, HelpCircle,
} from "lucide-react";
import gongulbakiLogo from "@/assets/gongulbaki-logo.png";
import { Document, Packer, Paragraph, TextRun } from "docx";
import Genogram from "./Genogram";

// HWP 저장 = docx 형식으로 저장 (HWP 호환)

type Speaker = "C" | "P" | "X" | "E";
type Line = { id: number; speaker: Speaker; index: number; time: number; text: string; };

const speakerLabel = (s: Speaker, i: number) =>
  s === "C" ? `상${i}` : s === "P" ? `내${i}` : s === "X" ? `제3자${i}` : `기타${i}`;

const speakerColor = (s: Speaker) =>
  s === "C" ? { bg: "#e8f4e8", text: "#2d7a3a", border: "#a8d8a8", light: "#e8f4e833" }
  : s === "P" ? { bg: "#fff0e0", text: "#c06010", border: "#f0c080", light: "#fff0e033" }
  : s === "X" ? { bg: "#e0f0ff", text: "#2060a0", border: "#90c0f0", light: "#e0f0ff33" }
  : { bg: "#e8f8f4", text: "#1a7a5a", border: "#80d0b8", light: "#e8f8f433" };

const fmt = (s: number) => {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

const nextSpeakerOf = (s: Speaker): Speaker => s === "C" ? "P" : "C";

const playDing = async () => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === "suspended") await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(); osc.stop(ctx.currentTime + 0.5);
  } catch {}
};

// 로고 컴포넌트 - 실제 이미지 사용
const Logo = ({ size = 36 }: { size?: number }) => (
  <img src={gongulbakiLogo} alt="곤글박이 로고" width={size} height={size} style={{ objectFit: "contain" }} />
);


// ── IndexedDB 오디오 저장/복원 헬퍼 ──────────────────────────────
const IDB_NAME = "gongulbaki";
const IDB_STORE = "audio";
const IDB_KEY = "current";

function openAudioDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function saveAudioToDB(file: File): Promise<void> {
  const db = await openAudioDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put({ name: file.name, blob: file }, IDB_KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function loadAudioFromDB(): Promise<{ name: string; blob: Blob } | null> {
  try {
    const db = await openAudioDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => rej(req.error);
    });
  } catch { return null; }
}

async function clearAudioFromDB(): Promise<void> {
  try {
    const db = await openAudioDB();
    return new Promise((res) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch {}
}
// ─────────────────────────────────────────────────────────────────

// Electron window control API (브라우저 환경에서는 undefined)
const electronAPI = (window as any).electronAPI as {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onWindowStateChanged: (cb: (state: string) => void) => void;
  onCloseRequested?: (cb: () => void) => (() => void);
  confirmClose?: () => void;
  cancelClose?: () => void;
} | undefined;

// ── 모델 관리 컴포넌트 ────────────────────────────────────────────
type ModelStatus = { cached: boolean; loaded: boolean };
type ModelsState = Record<string, ModelStatus>;

const MODEL_INFO: { key: string; label: string; size: string; desc: string }[] = [
  { key: "small",    label: "Small",    size: "약 500MB", desc: "빠름" },
  { key: "medium",   label: "Medium",   size: "약 1.5GB", desc: "권장 ★" },
  { key: "large-v3", label: "Large-v3", size: "약 6GB",   desc: "최고 정확도" },
];

type Engine = "python" | "cpp";

function ModelManager({
  currentModel, onModelChange,
  currentEngine, onEngineChange,
}: {
  currentModel: string; onModelChange: (m: string) => void;
  currentEngine: Engine; onEngineChange: (e: Engine) => void;
}) {
  const [modelsState, setModelsState]     = useState<ModelsState>({});
  const [cppModelsState, setCppModelsState] = useState<ModelsState>({});
  const [downloading, setDownloading]     = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState("");
  const [deleting, setDeleting]           = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const [r1, r2] = await Promise.all([
        fetch("http://127.0.0.1:5577/api/models/status"),
        fetch("http://127.0.0.1:5577/api/models/cpp/status"),
      ]);
      setModelsState(await r1.json());
      setCppModelsState(await r2.json());
    } catch {}
  };

  useEffect(() => { fetchStatus(); }, []);

  // 현재 엔진에 따라 상태 선택
  const activeState = currentEngine === "cpp" ? cppModelsState : modelsState;

  const handleDownload = (key: string) => {
    setDownloading(key);
    setDownloadProgress(10);
    setDownloadError("");
    const url = currentEngine === "cpp"
      ? `http://127.0.0.1:5577/api/models/cpp/download/${key}`
      : `http://127.0.0.1:5577/api/models/download/${key}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.type === "start") setDownloadProgress(40);
      else if (d.type === "ping") setDownloadProgress(prev => Math.min(prev + 2, 90));
      else if (d.type === "done") {
        setDownloadProgress(100);
        es.close();
        setTimeout(() => { setDownloading(null); setDownloadProgress(0); fetchStatus(); }, 800);
      } else if (d.type === "error") {
        setDownloadError(d.msg);
        es.close();
        setTimeout(() => { setDownloading(null); setDownloadProgress(0); }, 2000);
      }
    };
    es.onerror = () => {
      es.close();
      setDownloadError("연결 오류");
      setTimeout(() => { setDownloading(null); setDownloadProgress(0); }, 2000);
    };
  };

  const handleDelete = async (key: string) => {
    const isCurrent = currentModel === key;
    const msg = isCurrent
      ? `현재 사용 중인 ${key} 모델을 삭제하시겠습니까?\n다음 변환 시 다른 모델이 자동으로 선택됩니다.`
      : `${key} 모델을 삭제하시겠습니까?\n삭제 후 다시 사용하려면 재다운로드가 필요합니다.`;
    if (!window.confirm(msg)) return;
    setDeleting(key);
    try {
      const url = currentEngine === "cpp"
        ? `http://127.0.0.1:5577/api/models/cpp/delete/${key}`
        : `http://127.0.0.1:5577/api/models/delete/${key}`;
      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) { alert(data.error || "삭제 실패"); }
      else { fetchStatus(); }
    } catch { alert("삭제 중 오류가 발생했습니다."); }
    setDeleting(null);
  };

  return (
    <div className="space-y-2 px-2">

      {/* ── 엔진 선택 (한 줄씩, 컴팩트) ── */}
      <div className="space-y-1">
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">변환 엔진</p>
        <div className="space-y-1">
          {([
            { id: "python" as Engine, label: "faster-whisper", badge: "기존", desc: "Python · GPU 지원" },
            { id: "cpp"    as Engine, label: "whisper.cpp",    badge: "신규", desc: "C++ · 가볍고 빠름" },
          ] as { id: Engine; label: string; badge: string; desc: string }[]).map(({ id, label, badge, desc }) => {
            const isSelected = currentEngine === id;
            const hasModels = id === "cpp"
              ? Object.values(cppModelsState).some(s => s.cached)
              : Object.values(modelsState).some(s => s.cached);
            return (
              <button key={id} onClick={() => onEngineChange(id)}
                className={`w-full rounded-lg border px-2.5 py-1.5 flex items-center gap-2 transition-colors text-left ${isSelected ? "border-[#3a6a4a] bg-[#f0f7f2]" : "border-gray-200 bg-gray-50 hover:bg-gray-100"}`}>
                <div className={`w-3 h-3 rounded-full border-2 shrink-0 transition-colors ${isSelected ? "border-[#3a6a4a] bg-[#3a6a4a]" : "border-gray-300 bg-white"}`} />
                <span className="text-xs font-semibold text-gray-700">{label}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${id === "cpp" ? "bg-blue-100 text-blue-600" : "bg-gray-100 text-gray-500"}`}>{badge}</span>
                <span className="text-[10px] text-gray-400">· {desc}</span>
                {!hasModels && <span className="text-[10px] text-orange-400 ml-auto shrink-0">모델 없음</span>}
                {isSelected && hasModels && <span className="text-[10px] font-bold text-[#3a6a4a] bg-[#e0f0e8] px-2 py-0.5 rounded-full shrink-0 ml-auto">사용 중</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 구분선 ── */}
      <div className="border-t border-gray-100" />

      {/* ── 모델 선택 ── */}
      <div className="space-y-1">
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">변환 모델</p>
        {MODEL_INFO.map(({ key, label, size, desc }) => {
          const st        = activeState[key];
          const isCurrent = currentModel === key;
          const isCached  = st?.cached ?? false;
          const isDownloading = downloading === key;
          const isDeleting    = deleting === key;
          const engineLabel   = currentEngine === "cpp" ? "whisper.cpp" : "Whisper";

          return (
            <div key={key}
              className={`rounded-lg border px-2.5 py-1.5 flex items-center gap-2 transition-colors ${isCurrent && isCached ? "border-[#3a6a4a] bg-[#f0f7f2]" : "border-gray-200 bg-gray-50"}`}>
              <button
                disabled={!isCached}
                onClick={() => isCached && onModelChange(key)}
                className={`w-3 h-3 rounded-full border-2 shrink-0 transition-colors ${isCurrent && isCached ? "border-[#3a6a4a] bg-[#3a6a4a]" : "border-gray-300 bg-white"} ${!isCached ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-gray-700">{engineLabel} {label}</span>
                  <span className="text-[10px] text-gray-400">· {desc}</span>
                  <span className="text-[10px] text-gray-400">({size})</span>
                </div>
                {isDownloading && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div className="h-full bg-[#3a6a4a] rounded-full transition-all duration-500" style={{ width: `${downloadProgress}%` }} />
                    </div>
                    <span className="text-[10px] text-gray-400 shrink-0">
                      {downloadError ? "❌ 오류" : downloadProgress < 100 ? "다운로드 중..." : "✓ 완료"}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {isCurrent && isCached && <span className="text-[10px] font-bold text-[#3a6a4a] bg-[#e0f0e8] px-2 py-0.5 rounded-full">사용 중</span>}
                {!isCached && !isDownloading && (
                  <button onClick={() => handleDownload(key)}
                    className="text-[10px] px-2.5 py-1 rounded-full bg-[#3a6a4a] text-white hover:bg-[#2d5a3a] transition-colors font-medium">
                    📥 다운로드
                  </button>
                )}
                {isDownloading && <span className="text-[10px] text-gray-400">⏳</span>}
                {isCached && !isDownloading && (
                  <button onClick={() => handleDelete(key)} disabled={isDeleting}
                    className="text-[10px] px-2 py-0.5 rounded-full border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors">
                    {isDeleting ? "삭제 중..." : "🗑️ 삭제"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────

// 투어 본문 렌더링 — 글머리(•, 이모지 등) 있는 줄은 flex hanging indent 처리
function renderTourBody(text: string) {
  // [?] 토큰을 실제 HelpCircle 아이콘으로 치환
  function renderInline(line: string): React.ReactNode {
    if (!line.includes("[?]")) return line;
    const parts = line.split("[?]");
    return (
      <>
        {parts.reduce<React.ReactNode[]>((acc, part, i) => {
          if (i > 0) acc.push(<HelpCircle key={i} className="inline w-3.5 h-3.5 mx-0.5 align-text-bottom" />);
          acc.push(part);
          return acc;
        }, [])}
      </>
    );
  }

  return (
    <div style={{ textWrap: "pretty" } as React.CSSProperties}>
      {text.split("\n").map((line, i) => {
        if (!line) return <div key={i} style={{ height: "0.4em" }} />;
        // 글머리(•·) 또는 이모지/특수기호로 시작하는 줄만 hanging indent
        // 한글(가-힣), 한자(一-鿿), 일본어(぀-ヿ) 제외
        const m = line.match(/^([•·]|(?![가-힣一-鿿぀-ヿ])[^\x00-\x7F]\S*)\s/);
        if (m) {
          const sym = m[1];
          const rest = line.slice(m[0].length);
          return (
            <div key={i} style={{ display: "flex", gap: "0.4em", alignItems: "flex-start" }}>
              <span style={{ flexShrink: 0, lineHeight: 1.6 }}>{sym}</span>
              <span style={{ flex: 1, minWidth: 0, lineHeight: 1.6 }}>{renderInline(rest)}</span>
            </div>
          );
        }
        return <div key={i} style={{ lineHeight: 1.6 }}>{renderInline(line)}</div>;
      })}
    </div>
  );
}

// "곤글박이" 텍스트만 함초롬바탕체로 렌더링
function renderGb(text: string) {
  if (!text.includes("곤글박이")) return <>{text}</>;
  const parts = text.split("곤글박이");
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && (
            <span style={{ fontFamily: "'HCR Batang','함초롬바탕',serif", fontWeight: "bold" }}>곤글박이</span>
          )}
        </span>
      ))}
    </>
  );
}

// ── 상황별 힌트 (Context Hint) ────────────────────────────────────
type ContextHintData = {
  target: string;
  title: string;
  body: string;
  position?: "top" | "bottom";
};

function ContextHint({ hint, onClose }: { hint: ContextHintData; onClose: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const TW = 260;

  useEffect(() => {
    const el = document.querySelector<HTMLElement>(`[data-tour="${hint.target}"]`);
    if (el) setRect(el.getBoundingClientRect());
  }, [hint.target]);

  useEffect(() => {
    const t = setTimeout(onClose, 10000);
    return () => clearTimeout(t);
  }, [onClose]);

  const getStyle = (): React.CSSProperties => {
    if (!rect) return { position: "fixed", bottom: 90, right: 16, zIndex: 8000, width: TW };
    const cx = rect.left + rect.width / 2;
    const pos = hint.position || "bottom";
    let top: number, left = cx - TW / 2;
    top = pos === "bottom" ? rect.bottom + 14 : rect.top - 140;
    left = Math.max(8, Math.min(left, window.innerWidth - TW - 8));
    top  = Math.max(8, top);
    return { position: "fixed", top, left, zIndex: 8000, width: TW };
  };

  return (
    <div
      className="bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden"
      style={getStyle()}
    >
      <div className="px-3.5 py-3">
        <div className="flex items-start justify-between gap-2 mb-1">
          <p className="font-medium text-gray-700 text-sm">{renderGb(hint.title)}</p>
          <button onClick={onClose}
            className="text-gray-300 hover:text-gray-500 shrink-0 text-xs leading-none mt-0.5">✕</button>
        </div>
        <div className="text-xs text-gray-500">{renderTourBody(hint.body)}</div>
      </div>
      <div className="h-px bg-gray-100 w-full">
        <div className="h-full bg-gray-300" style={{ animation: "hint-shrink 10s linear forwards" }} />
      </div>
      <style>{`@keyframes hint-shrink { from { width: 100% } to { width: 0% } }`}</style>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────

// ── 온보딩 투어 ────────────────────────────────────────────────────
type TourStepDef = {
  target: string | null;
  title: string;
  body: string;
  position?: "top" | "bottom" | "left" | "right";
  width?: number;
};

const GENOGRAM_TOUR_STEPS: TourStepDef[] = [
  { target: null,              title: "가계도 편집기 🌳",          body: "가족 구조와 구성원 간의 관계를\n시각적으로 그릴 수 있어요.\n주요 기능을 안내해 드릴게요." },
  { target: "geo-nodes",       title: "인물 추가 □ ○ ◇",          body: "버튼을 클릭하면 캔버스에 도형이 추가돼요.\n• 더블클릭: 이름 입력\n• 나이 자리 클릭: 나이 입력\n• 사망/내담자 토글로 상태 표시",                     position: "bottom" },
  { target: "geo-child-types", title: "자녀 유형",                  body: "유산·사산·임신 등 특수 자녀 도형이에요.\n• 임신: 빈 삼각형\n• 자연유산: 삼각형 + X\n• 인공유산: 삼각형 + X + 아랫선\n• 사산아: 작은 사각형 + X\n부모 관계선에 자녀로 연결해 사용해요.",             position: "bottom" },
  { target: "geo-lines",       title: "관계선 연결",                body: "선 종류를 먼저 선택하세요.\n인물을 우클릭 → 연결 모드 시작\n연결할 인물을 클릭하면 선이 그어집니다.\nEsc로 취소",                                         position: "bottom" },
  { target: "geo-child-line",  title: "자녀선 종류",                body: "자녀 연결선 종류를 선택해요.\n• 일반: 실선\n• 위탁: 점선\n• 입양: 이중선",                                                                              position: "bottom" },
  { target: "geo-twins",       title: "쌍둥이",                     body: "Shift+클릭으로 자녀 2명 이상 선택 후\n쌍둥이 버튼을 클릭하면 선이 그어져요.\n• 쌍둥이: 이란성 (V자 선)\n• 일란성: V자 + 두 자녀 사이 가로선",             position: "bottom" },
  { target: "geo-substance",   title: "약물 · 정신 · 신체 표시",    body: "인물을 선택한 뒤 버튼을 클릭하면 도형 안에 표시가 채워져요.\n• 약물남용: 아래 절반 검정\n• 정신신체문제: 왼쪽 절반 검정\n• 약물+정신/신체: 3/4 검정\n• 의심: 아래 절반 회색\n• 회복: 우하단 검정 + 좌하단 회색\n다시 클릭하면 표시가 해제돼요.",          position: "bottom", width: 340 },
  { target: "geo-textbox",     title: "텍스트 상자 T",              body: "캔버스 어디든 메모나 설명을 자유롭게 추가할 수 있어요.\n① T 버튼 클릭 → 커서 모양 변경\n② 원하는 위치 클릭 → 텍스트 상자 생성\n더블클릭으로 내용 수정, 드래그로 이동,\n모서리 드래그로 크기 조절이 가능해요.\n색상(검정·빨강·파랑)과 글자 크기도 조절 가능해요.", position: "bottom", width: 340 },
  { target: "geo-side-panel",  title: "감정선 · 학대 · 갈등",       body: "오른쪽 패널에 추가 선 종류가 있어요.\n• 감정 관계선: 무관심\n• 학대·갈등: 정서적학대, 방임, 통제\n패널 닫기(›) / 열기(‹) 가능",                        position: "left" },
  { target: "geo-actions",     title: "자녀 추가 · 뒤로",           body: "자녀 추가: 결혼/동거선 선택 후 클릭 →\n연결할 자녀 노드 클릭\n↩ 뒤로: 최대 30단계 실행 취소 (Ctrl+Z)",                                              position: "bottom" },
  { target: "geo-save",        title: "저장 · 불러오기 · 삭제",     body: "💾 저장: SVG(이미지) / JSON(이후 수정 가능)\n📂 열기: 저장된 JSON 파일 불러오기\n🗑️ 삭제(삭/제): 선택한 인물·선 삭제 (Delete 키도 가능)", position: "bottom", width: 340 },
  { target: "geo-canvas",      title: "캔버스 조작",                body: "• 드래그: 인물 이동\n• Shift+클릭: 다중 선택\n• 휠 스크롤: 줌 인/아웃\n• Alt+드래그: 화면 이동\n• Delete: 선택 항목 삭제",                              position: "top"    },
  { target: "help-btn",        title: "문제가 생겼을 때 🔧",        body: "이 버튼을 클릭하면 자주 발생하는 문제와\n해결 방법 안내 페이지가 열려요.\n\n📋 버튼: 디버그 로그 복사 후 문의 시 전송",                              position: "bottom" },
  { target: null,              title: "가계도 준비 완료! ✅",       body: "이제 직접 그려보세요!\n[?] 버튼으로 언제든 다시 볼 수 있어요." },
];

const TOUR_STEPS: TourStepDef[] = [
  { target: null,               title: "곤글박이에 오신 걸 환영합니다! 🪶",  body: "상담 녹음 파일을 자동으로 텍스트로 변환하고\n축어록을 쉽게 작성할 수 있어요.\n주요 기능을 빠르게 안내해 드릴게요.", width: 360 },
  { target: "tabs",             title: "두 가지 탭",                           body: "축어록 작성과 가계도 편집,\n두 기능을 탭으로 전환할 수 있어요.",                                                             position: "bottom" },
  { target: "btn-open-file",    title: "파일 열기 📂",                        body: "음성 파일(mp3, wav, m4a 등)을 불러오세요.\n자동으로 텍스트 변환이 시작돼요.\n변환 중 절전이 되어도 재실행 시 이어받기가 가능합니다.",    position: "bottom" },
  { target: "btn-open-session", title: "세션 열기",                            body: "JSON으로 저장한 세션 파일을 불러와\n화자 분리 상태 그대로 이어서 편집해요.\n편집 중 파일 열기 → 재생만으로 음성을 따로 불러올 수 있어요.", position: "bottom" },
  { target: "btn-save",         title: "문서 저장 💾",                         body: "📄 Word (.docx): 축어록 양식으로 자동 변환\n📋 JSON: 세션 열기로 다시 불러와 수정 가능\n\n⚠️ 종료 시 저장하지 않은 내용은 사라집니다.",    position: "bottom", width: 380 },
  { target: "btn-split",        title: "화자 분리 ✏️",                         body: "변환 완료 후 이 버튼으로 편집 모드로 전환해요.\n• Enter: 줄 분할 + 화자 자동 전환\n• 화자 칩 클릭: 상담사 ↔ 내담자 ↔ 제3자\n• 되돌리기: 최대 30단계 실행 취소",   position: "bottom" },
  { target: "player",           title: "오디오 플레이어 ▶️",                   body: "음성을 들으면서 변환 텍스트를 수정해요.\n• Shift+Space / Esc: 재생/정지\n• Shift+←/→: 3초 이동\n• 진행 바 클릭: 원하는 위치로 이동",               position: "top"    },
  { target: "settings-btn",     title: "설정 ⚙️",                              body: "변환 엔진·모델 선택, 사용자 이름,\n시간 표시 여부를 설정할 수 있어요.",                                                              position: "bottom" },
  { target: "help-btn",         title: "문제가 생겼을 때 🔧",                   body: "이 버튼을 클릭하면 자주 발생하는 문제와\n해결 방법을 안내하는 페이지가 열려요.\n\n📋 버튼으로 디버그 로그를 복사해\n문의 시 함께 보내주시면 도움이 됩니다.",          position: "bottom" },
  { target: null,               title: "모든 준비 완료! ✅",                    body: "이제 곤글박이를 직접 사용해 보세요!\n\n헤더의 [?] 버튼을 누르면 언제든\n이 투어를 다시 볼 수 있어요." },
];

function TourOverlay({
  step, stepIndex, total, onNext, onPrev, onClose,
}: {
  step: TourStepDef; stepIndex: number; total: number;
  onNext: () => void; onPrev: () => void; onClose: () => void;
}) {
  const [spotlight, setSpotlight] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!step.target) { setSpotlight(null); return; }
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (!el) { setSpotlight(null); return; }
    setSpotlight(el.getBoundingClientRect());
  }, [step]);

  const TW = step.width ?? 300;
  const PAD = 10;
  const SP = 6;

  const tooltipStyle = (): React.CSSProperties => {
    if (!spotlight) {
      return { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 9002, width: TW };
    }
    const pos = step.position || "bottom";
    const cx = spotlight.left + spotlight.width / 2;
    let top: number, left: number;
    if (pos === "bottom") {
      top = spotlight.bottom + SP + PAD;
      left = cx - TW / 2;
    } else if (pos === "top") {
      top = spotlight.top - SP - PAD - 200;
      left = cx - TW / 2;
    } else if (pos === "right") {
      top = spotlight.top;
      left = spotlight.right + SP + PAD;
    } else {
      top = spotlight.top;
      left = spotlight.left - TW - SP - PAD;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - TW - 8));
    top  = Math.max(8, top);
    return { position: "fixed", top, left, zIndex: 9002, width: TW };
  };

  return (
    <>
      {/* 스포트라이트가 없을 때 가벼운 오버레이 */}
      {!spotlight && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.25)", zIndex: 9000, pointerEvents: "none" }} />
      )}

      {/* 스포트라이트: box-shadow로 외부 살짝 어둡게 + 초록 테두리 */}
      {spotlight && (
        <div style={{
          position: "fixed",
          top: spotlight.top - SP,
          left: spotlight.left - SP,
          width: spotlight.width + SP * 2,
          height: spotlight.height + SP * 2,
          borderRadius: 10,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.35), 0 0 0 2px #d1d5db",
          background: "transparent",
          zIndex: 9001,
          pointerEvents: "none",
        }} />
      )}

      {/* 툴팁 카드 */}
      <div style={tooltipStyle()} className="bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden">
        <div className="px-4 py-3.5">
          <p className="font-medium text-gray-700 text-sm mb-1">{renderGb(step.title)}</p>
          <div className="text-sm text-gray-500">{renderTourBody(step.body)}</div>
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
            <button onClick={onClose} className="text-[11px] text-gray-400 hover:text-gray-600">건너뛰기</button>
            <div className="flex items-center gap-1.5">
              {stepIndex > 0 && (
                <button onClick={onPrev}
                  className="text-xs px-3 py-1.5 rounded-md border border-gray-200 hover:bg-gray-50 text-gray-600">
                  이전
                </button>
              )}
              <button onClick={onNext}
                className="text-xs px-3 py-1.5 rounded-md border border-gray-200 hover:bg-gray-50 text-gray-700 font-medium">
                {stepIndex === total - 1 ? "완료" : "다음 →"}
              </button>
            </div>
          </div>
          <div className="flex justify-center gap-1.5 mt-2.5">
            {Array.from({ length: total }).map((_, i) => (
              <div key={i} className="rounded-full transition-all duration-200"
                style={{ width: i === stepIndex ? 12 : 5, height: 5, background: i === stepIndex ? "#6b7280" : "#e5e7eb" }} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
// ─────────────────────────────────────────────────────────────────

export default function Index() {
  const [userName, setUserName] = useState(() => localStorage.getItem("gb_user") || "");
  const [tempName, setTempName] = useState(userName);
  const [model, setModel] = useState(() => localStorage.getItem("gb_model") || "medium");
  const [engine, setEngine] = useState<Engine>(() => (localStorage.getItem("gb_engine") as Engine) || "python");
  const [showTime, setShowTime] = useState(false);
  const [isMaximized, setIsMaximized] = useState(true);
  const [showExitModal, setShowExitModal] = useState(false);

  // Electron 창 상태 초기화 및 구독
  useEffect(() => {
    if (!electronAPI) return;
    electronAPI.isMaximized().then(setIsMaximized);
    electronAPI.onWindowStateChanged((state) => setIsMaximized(state === "maximized"));
    // 메인 프로세스 창 닫기 요청 수신 (OS X버튼 등)
    const cleanup = electronAPI.onCloseRequested?.(() => setShowExitModal(true));
    return () => { cleanup?.(); };
  }, []);
  const [activeTab, setActiveTab] = useState<"transcribe" | "genogram">("transcribe");
  const [openSettings, setOpenSettings] = useState(!localStorage.getItem("gb_user"));
  const [openManual, setOpenManual] = useState(false);
  const [manualTab, setManualTab] = useState<"transcribe" | "genogram">("transcribe");
  const [tourStep, setTourStep] = useState(-1);
  const [geoTourStep, setGeoTourStep] = useState(-1);
  const [contextHint, setContextHint] = useState<ContextHintData | null>(null);

  useEffect(() => { localStorage.setItem("gb_user", userName); }, [userName]);
  useEffect(() => { localStorage.setItem("gb_model", model); }, [model]);
  useEffect(() => { localStorage.setItem("gb_engine", engine); }, [engine]);

  const tourAutoStarted = useRef(false);

  // 재방문 사용자 (이름 있고 투어 안 본 경우) — 앱 시작 시 자동
  useEffect(() => {
    if (!localStorage.getItem("gb_tour_done") && localStorage.getItem("gb_user")) {
      tourAutoStarted.current = true;
      const t = setTimeout(() => setTourStep(0), 800);
      return () => clearTimeout(t);
    }
  }, []);

  // 최초 설치 (이름 처음 저장 시) — 설정창 닫힌 뒤 자동
  const prevUserNameRef = useRef(userName);
  useEffect(() => {
    if (userName && !prevUserNameRef.current && !localStorage.getItem("gb_tour_done") && !tourAutoStarted.current) {
      tourAutoStarted.current = true;
      const t = setTimeout(() => setTourStep(0), 600);
      return () => clearTimeout(t);
    }
    prevUserNameRef.current = userName;
  }, [userName]);

  const geoTourAutoStarted = useRef(false);
  useEffect(() => {
    if (activeTab === "genogram" && !localStorage.getItem("gb_geo_tour_done") && !geoTourAutoStarted.current) {
      geoTourAutoStarted.current = true;
      const t = setTimeout(() => setGeoTourStep(0), 600);
      return () => clearTimeout(t);
    }
  }, [activeTab]);

  const [mode, setMode] = useState<"raw" | "split">("raw");
  const [rawText, setRawText] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [linesHistory, setLinesHistory] = useState<Line[][]>([]);
  const [filterSpeaker, setFilterSpeaker] = useState<Speaker | "ALL">("ALL");

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null);

  const [converting, setConverting] = useState(false);

  // ── 상황별 힌트 트리거 ──────────────────────────────────────────
  const prevConvertingRef = useRef(false);
  useEffect(() => {
    if (prevConvertingRef.current && !converting && rawText.trim()) {
      if (!localStorage.getItem("gb_hint_split")) {
        const t = setTimeout(() => {
          setContextHint({ target: "btn-split", title: "변환 완료! ✅", body: "화자 분리 시작 버튼을 눌러\n편집 모드로 전환하세요.", position: "bottom" });
          localStorage.setItem("gb_hint_split", "1");
        }, 400);
        return () => clearTimeout(t);
      }
    }
    prevConvertingRef.current = converting;
  }, [converting, rawText]);

  const splitHintShownRef = useRef(false);
  useEffect(() => {
    if (mode === "split" && !splitHintShownRef.current && !localStorage.getItem("gb_hint_editing")) {
      splitHintShownRef.current = true;
      const t = setTimeout(() => {
        setContextHint({
          target: "btn-undo",
          title: "화자 분리 편집 모드 ✏️",
          body: "• Enter: 커서 위치에서 줄 분할\n• 화자 칩 클릭: 상담사↔내담자↔제3자\n• Backspace(줄 맨 앞): 이전 줄과 합치기\n• 되돌리기 버튼: 최대 30단계 실행 취소",
          position: "bottom",
        });
        localStorage.setItem("gb_hint_editing", "1");
      }, 400);
      return () => clearTimeout(t);
    }
  }, [mode]);

  const [convertStatus, setConvertStatus] = useState("");
  const [convertProgress, setConvertProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  const errorHintShownRef = useRef(false);
  useEffect(() => {
    if (errorMsg && !errorHintShownRef.current && !localStorage.getItem("gb_hint_error")) {
      errorHintShownRef.current = true;
      const t = setTimeout(() => {
        setContextHint({
          target: "debug-btn",
          title: "문제가 생겼나요? 📋",
          body: "상단 📋 버튼을 클릭하면 디버그 로그가\n클립보드에 복사돼요.\n문의 시 붙여넣기해서 보내주시면\n원인 파악에 도움이 됩니다.\n🔧 버튼으로 문제 해결 안내도 확인하세요.",
          position: "bottom",
        });
        localStorage.setItem("gb_hint_error", "1");
      }, 1000);
      return () => clearTimeout(t);
    }
  }, [errorMsg]);
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancelConvert = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setConverting(false);
    setConvertStatus("");
    setErrorMsg("변환이 취소됐어요.");
  };

  // 이어하기 관련 상태
  const [resumeBanner, setResumeBanner] = useState<{ fileName: string; progress: number; text: string; startSec: number; blob?: Blob } | null>(null);

  // 절전 복귀 감지 → fetch 스트림이 끊기면 catch에서 자동 처리됨 (별도 이벤트 불필요)

  // 시작 시 자동복원 제거 — 종료 시 데이터 초기화로 대체

  useEffect(() => { if (rawText) localStorage.setItem("gb_autosave_raw", rawText); }, [rawText]);

  // 종료 시 초기화 — 변환 중이 아닐 때만 (이어받기 데이터는 그대로 유지)
  useEffect(() => {
    const onUnload = () => {
      if (!localStorage.getItem("gb_convert_progress")) {
        localStorage.removeItem("gb_autosave_raw");
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const onTime = () => setCurrent(a.currentTime);
    const onMeta = () => setDuration(a.duration);
    const onEnd = () => setPlaying(false);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnd);
    // 이미 로드된 경우 duration 즉시 반영
    if (a.readyState >= 1 && isFinite(a.duration)) setDuration(a.duration);
    return () => { a.removeEventListener("timeupdate", onTime); a.removeEventListener("loadedmetadata", onMeta); a.removeEventListener("ended", onEnd); };
  }, [audioUrl]);

  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = rate; }, [rate]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current; if (!a || !audioUrl) return;
    if (playing) { a.pause(); setPlaying(false); } else { a.play(); setPlaying(true); }
  }, [playing, audioUrl]);

  const seek = (sec: number) => {
    const a = audioRef.current; if (!a) return;
    a.currentTime = Math.max(0, Math.min(a.duration || 0, a.currentTime + sec));
  };
  const seekTo = (t: number) => { if (audioRef.current) audioRef.current.currentTime = t; };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const editing = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      // Shift+Space: 편집 중/밖 모두 재생/멈춤
      if (e.code === "Space" && e.shiftKey) { e.preventDefault(); togglePlay(); return; }
      // Shift+←/→: 편집 중/밖 모두 3초 이동
      if (e.key === "ArrowLeft" && e.shiftKey) { e.preventDefault(); seek(-3); return; }
      if (e.key === "ArrowRight" && e.shiftKey) { e.preventDefault(); seek(3); return; }
      // Esc: 편집 중/밖 모두 재생/멈춤 (기존 유지)
      if (e.key === "Escape") { e.preventDefault(); togglePlay(); return; }
      // 편집 중이면 이하 단축키 비활성
      if (editing) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      if (e.key === "ArrowLeft") seek(-3);
      if (e.key === "ArrowRight") seek(3);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  const nextIndexFor = (arr: Line[], sp: Speaker) => arr.filter(l => l.speaker === sp).length + 1;

  const startSplitting = () => {
    setLines([{ id: Date.now(), speaker: "C", index: 1, time: current, text: rawText.trim() }]);
    setMode("split");
  };

  const setCursorAt = (el: HTMLDivElement, pos: number) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    let remaining = pos;
    const walk = (node: Node): boolean => {
      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.textContent?.length ?? 0;
        if (remaining <= len) { range.setStart(node, remaining); range.collapse(true); return true; }
        remaining -= len;
      } else {
        for (const child of Array.from(node.childNodes)) { if (walk(child)) return true; }
      }
      return false;
    };
    if (!walk(el)) { range.selectNodeContents(el); range.collapse(false); }
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const handleSplitKey = (e: React.KeyboardEvent<HTMLDivElement>, lineId: number) => {
    // ── Enter: 줄 분할 ──────────────────────────────────────────
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const full = el.textContent || "";
      const sel = window.getSelection();
      let cursor = full.length;
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const pre = range.cloneRange();
        pre.selectNodeContents(el);
        pre.setEnd(range.endContainer, range.endOffset);
        cursor = pre.toString().length;
      }
      setLinesWithHistory(prev => {
        const idx = prev.findIndex(l => l.id === lineId);
        if (idx < 0) return prev;
        const cur = prev[idx];
        const head = [...prev.slice(0, idx), { ...cur, text: full.slice(0, cursor).trim() }];
        const sp: Speaker = nextSpeakerOf(cur.speaker);
        const newLine: Line = { id: Date.now(), speaker: sp, index: nextIndexFor(head, sp), time: current, text: full.slice(cursor).trim() };
        setTimeout(() => document.querySelector<HTMLDivElement>(`[data-line-id="${newLine.id}"]`)?.focus(), 0);
        return [...head, newLine, ...prev.slice(idx + 1)];
      });
      return;
    }

    // ── Backspace: 줄 맨 앞에서 이전 줄과 합치기 ──────────────
    if (e.key === "Backspace") {
      const el = e.currentTarget;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.getRangeAt(0).collapsed) return;
      const range = sel.getRangeAt(0);
      const pre = range.cloneRange();
      pre.selectNodeContents(el);
      pre.setEnd(range.startContainer, range.startOffset);
      if (pre.toString().length !== 0) return; // 커서가 맨 앞이 아니면 기본 동작

      e.preventDefault();
      const currentText = el.textContent || "";
      setLinesWithHistory(prev => {
        const idx = prev.findIndex(l => l.id === lineId);
        if (idx <= 0) return prev; // 첫 줄은 합칠 이전 줄 없음
        const prevLine = prev[idx - 1];
        const mergePoint = prevLine.text.length;
        const merged = prevLine.text + currentText;
        const newLines = renumber([
          ...prev.slice(0, idx - 1),
          { ...prevLine, text: merged },
          ...prev.slice(idx + 1),
        ]);
        setTimeout(() => {
          const prevEl = document.querySelector<HTMLDivElement>(`[data-line-id="${prevLine.id}"]`);
          if (prevEl) { prevEl.focus(); setCursorAt(prevEl, mergePoint); }
        }, 0);
        return newLines;
      });
    }
  };

  const updateText = (id: number, text: string) => {
    const current = linesRef.current.find(l => l.id === id);
    if (!current || current.text === text) return; // 변경 없으면 히스토리 저장 안 함
    setLinesWithHistory(prev => prev.map(l => l.id === id ? { ...l, text } : l));
  };

  const renumber = (arr: Line[]): Line[] => {
    const counts: Record<string, number> = {};
    return arr.map(l => { counts[l.speaker] = (counts[l.speaker] || 0) + 1; return { ...l, index: counts[l.speaker] }; });
  };

  // ── 되돌리기: ref로 항상 최신 lines 참조 ──────────────────────
  const linesRef = useRef<Line[]>([]);
  useEffect(() => { linesRef.current = lines; }, [lines]);

  const setLinesWithHistory = (updater: (prev: Line[]) => Line[]) => {
    const prev = linesRef.current;
    const next = updater(prev);
    setLinesHistory(h => [...h.slice(-30), prev]);
    setLines(next);
  };

  const undoLines = () => {
    setLinesHistory(h => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setLines(prev);
      return h.slice(0, -1);
    });
  };

  const cycleSpeaker = (id: number) => {
    setLinesWithHistory(prev => {
      const out: Line[] = [];
      for (const l of prev) {
        if (l.id !== id) { out.push(l); continue; }
        const order: Speaker[] = ["C", "P", "X", "E"];
        const sp = order[(order.indexOf(l.speaker) + 1) % 4];
        out.push({ ...l, speaker: sp, index: nextIndexFor(out, sp) });
      }
      return renumber(out);
    });
  };

  // ── 오디오만 로드 (변환 없이 재생만) ──────────────────────────
  const loadAudio = (f: File) => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    saveAudioToDB(f).catch(() => {});
    const url = URL.createObjectURL(f);
    setAudioUrl(url);
    setFileName(f.name);
    setResumeBanner(null);
    // duration 확보: 새 URL이 세팅된 직후 audio 엘리먼트를 강제 로드
    setTimeout(() => {
      const a = audioRef.current;
      if (!a) return;
      a.load();
      a.onloadedmetadata = () => setDuration(a.duration);
    }, 0);
  };

  // ── 파일 선택 시 재생만 할지 변환할지 선택 ─────────────────────
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [showNewRecordModal, setShowNewRecordModal] = useState(false);
  const [pendingSaveDocxBlob, setPendingSaveDocxBlob] = useState<Blob | null>(null);
  const [pendingSaveName, setPendingSaveName] = useState("");
  const onFileSelect = (f: File) => {
    setPendingFile(f);
  };

  const onFile = async (f: File, resumeFrom?: { text: string; startSec: number; progress: number }) => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    saveAudioToDB(f).catch(() => {});
    const url = URL.createObjectURL(f);
    setAudioUrl(url);
    setFileName(f.name);
    setResumeBanner(null);
    setMode("raw");
    // duration 확보
    setTimeout(() => {
      const a = audioRef.current;
      if (!a) return;
      a.load();
      a.onloadedmetadata = () => setDuration(a.duration);
    }, 0);
    const initText = resumeFrom ? resumeFrom.text : "";
    setRawText(initText);
    setConverting(true);
    setErrorMsg("");
    setConvertProgress(resumeFrom?.progress ?? 0);
    setConvertStatus("음향 분석 중...");
    const baseOffset = resumeFrom?.startSec ?? 0;
    localStorage.setItem("gb_convert_progress", JSON.stringify({ fileName: f.name, progress: resumeFrom?.progress ?? 0, text: initText, startSec: baseOffset }));
    // 선택된 엔진+모델이 다운로드되어 있는지 확인, 없으면 사용 가능한 것으로 자동 전환
    let useEngine = engine;
    let useModel = model;
    try {
      const [r1, r2] = await Promise.all([
        fetch("http://127.0.0.1:5577/api/models/status"),
        fetch("http://127.0.0.1:5577/api/models/cpp/status"),
      ]);
      const pyState: ModelsState = await r1.json();
      const cppSt: ModelsState = await r2.json();
      const active = engine === "cpp" ? cppSt : pyState;
      if (!active[model]?.cached) {
        let found = false;
        for (const [k, s] of Object.entries(pyState))  { if (s.cached) { useEngine = "python"; useModel = k; found = true; break; } }
        if (!found) for (const [k, s] of Object.entries(cppSt)) { if (s.cached) { useEngine = "cpp";    useModel = k; found = true; break; } }
        if (!found) {
          setConverting(false); setConvertStatus("");
          setErrorMsg("다운로드된 모델이 없습니다. 설정(⚙️)에서 모델을 다운로드해주세요.");
          return;
        }
        setEngine(useEngine); setModel(useModel);
        setConvertStatus(`모델 자동 전환: ${useEngine === "cpp" ? "whisper.cpp" : "Whisper"} ${useModel}`);
      }
    } catch { /* API 확인 실패 시 현재 선택 그대로 진행 */ }

    const fd = new FormData();
    fd.append("file", f); fd.append("model", useModel); fd.append("engine", useEngine); fd.append("show_time", showTime ? "true" : "false");
    if (resumeFrom) fd.append("start_sec", String(resumeFrom.startSec));

    // AbortController — 취소 버튼 또는 타임아웃 시 사용
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // 60초 응답 없으면 자동 타임아웃
    const timeoutId = setTimeout(() => {
      if (abortControllerRef.current === controller) {
        controller.abort();
        setConverting(false);
        setConvertStatus("");
        setErrorMsg("응답이 없어요. 파일 형식을 확인하거나 앱을 재실행 후 다시 시도해보세요.");
      }
    }, 60000);

    try {
      const res = await fetch("http://127.0.0.1:5577/api/transcribe", { method: "POST", body: fd, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`서버 오류: ${res.status}`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "", collected = initText;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop()!;
        for (const part of parts) {
          if (!part.startsWith("data:")) continue;
          try {
            const d = JSON.parse(part.slice(5).trim());
            if (d.type === "status") setConvertStatus(d.msg);
            else if (d.type === "segment" || d.type === "silence") {
              collected += d.text + "\n\n"; setRawText(collected);
              const prog = d.progress ?? 0;
              setConvertProgress(prog); setConvertStatus(`변환 중... ${prog}%`);
              const segEndSec = d.end_sec != null ? (baseOffset + d.end_sec) : (baseOffset + (d.start_sec ?? 0));
              localStorage.setItem("gb_convert_progress", JSON.stringify({ fileName: f.name, progress: prog, text: collected, startSec: segEndSec }));
            } else if (d.type === "done") {
              setConvertProgress(100); setConvertStatus("✅ 변환 완료!");
              localStorage.removeItem("gb_convert_progress");
              playDing(); setTimeout(() => setConverting(false), 2000);
            } else if (d.type === "error") throw new Error(d.msg);
          } catch (pe) { if ((pe as Error).name === "SyntaxError") continue; throw pe; }
        }
      }
    } catch (err) {
      clearTimeout(timeoutId);
      abortControllerRef.current = null;

      // 취소된 경우 (AbortError) — 별도 처리
      if ((err as any)?.name === "AbortError") {
        setConverting(false);
        setConvertStatus("");
        return;
      }

      const saved = localStorage.getItem("gb_convert_progress");
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed.text && parsed.progress < 100) {
            const msg = "변환이 중단되었어요. 아래 '이어서 변환' 버튼을 눌러 재개하세요.";
            setConvertStatus("❌ " + msg);
            setErrorMsg(msg);
            loadAudioFromDB().then(data => {
              setResumeBanner({ ...parsed, startSec: parsed.startSec ?? 0, blob: data?.blob });
            });
          } else {
            const msg = (err as Error).message;
            setConvertStatus("❌ " + msg);
            setErrorMsg(msg);
          }
        } catch {
          const msg = (err as Error).message;
          setConvertStatus("❌ " + msg);
          setErrorMsg(msg);
        }
      } else {
        const msg = (err as Error).message;
        setConvertStatus("❌ " + msg);
        setErrorMsg(msg);
      }
      setTimeout(() => setConverting(false), 4000);
    }
  };

  const newRecord = () => {
    if (rawText && !window.confirm("현재 내용이 지워집니다. 새 기록을 시작할까요?")) return;
    setRawText(""); setLines([]); setMode("raw");
    setFileName(""); if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null); setCurrent(0); setDuration(0); setPlaying(false);
    setResumeBanner(null);
    localStorage.removeItem("gb_autosave_raw");
    localStorage.removeItem("gb_convert_progress");
    clearAudioFromDB().catch(() => {});
  };

  const baseName = () => fileName.replace(/\.[^.]+$/, "") || "축어록";

  // File System Access API 지원 여부 확인
  const hasFsApi = typeof window !== "undefined" && "showSaveFilePicker" in window;

  const exportTxt = async () => {
    const body = mode === "raw" ? rawText
      : lines.filter(l => l.text.trim()).map(l => {
          const tag = speakerLabel(l.speaker, l.index);
          const timeStr = showTime ? ` (${fmt(l.time)})` : "";
          return `${tag}${timeStr} : ${l.text}`;
        }).join("\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });

    if (hasFsApi) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: baseName() + ".txt",
          types: [{ description: "텍스트 파일", accept: { "text/plain": [".txt"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (e: any) {
        if (e?.name === "AbortError") return; // 취소
      }
    }
    // fallback
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = baseName() + ".txt"; a.click();
  };

  const exportDocx = async () => {
    const paras: Paragraph[] = [];
    if (mode === "raw") {
      for (const p of rawText.split(/\n+/)) {
        if (!p.trim()) continue;
        paras.push(new Paragraph({ children: [new TextRun({ text: p, size: 24 })] }));
      }
    } else {
      const activeLines = lines.filter(l => l.text.trim());
      for (let i = 0; i < activeLines.length; i++) {
        const l = activeLines[i];
        const tag = speakerLabel(l.speaker, l.index);
        const timeStr = showTime ? ` (${fmt(l.time)})` : "";
        const prefix = `${tag}${timeStr} : `;
        const indent = prefix.length * 115;
        // 이전 발화자와 다를 때 위 간격 넓힘
        const prevSpeaker = i > 0 ? activeLines[i - 1].speaker : null;
        const spacingBefore = prevSpeaker !== null && prevSpeaker !== l.speaker ? 160 : 0;
        paras.push(new Paragraph({
          indent: { left: indent, hanging: indent },
          spacing: { before: spacingBefore, after: 40, line: 276, lineRule: "auto" },
          children: [
            new TextRun({ text: prefix, bold: true, color: "000000", size: 24 }),
            new TextRun({ text: l.text, color: "000000", size: 24 }),
          ],
        }));
      }
    }
    const doc = new Document({
      sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, bottom: 1000, left: 1200, right: 1200 } } }, children: paras }],
    });
    const docxBlob = await Packer.toBlob(doc);
    const name = baseName();
    setPendingSaveDocxBlob(docxBlob);
    setPendingSaveName(name);
    setShowSessionModal(true);
  };

  const doSaveDocx = async (docxBlob: Blob, name: string, withJson: boolean) => {
    const sessionData = JSON.stringify({ version: 1, fileName, mode, rawText, lines, showTime });
    const jsonBlob = new Blob([sessionData], { type: "application/json;charset=utf-8" });

    if (hasFsApi) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: name + ".docx",
          types: [{ description: "Word 문서", accept: { "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(docxBlob);
        await writable.close();
        if (withJson) {
          const savedName = (handle.name as string).replace(/\.docx$/i, "");
          try {
            const dir = await (handle as any).getParent();
            const jh = await dir.getFileHandle(savedName + "_세션.json", { create: true });
            const jw = await jh.createWritable();
            await jw.write(jsonBlob);
            await jw.close();
          } catch {
            // getParent 실패 시 showSaveFilePicker로 JSON도 await 처리
            try {
              const jhandle = await (window as any).showSaveFilePicker({
                suggestedName: savedName + "_세션.json",
                types: [{ description: "세션 파일", accept: { "application/json": [".json"] } }],
              });
              const jw = await jhandle.createWritable();
              await jw.write(jsonBlob);
              await jw.close();
            } catch (je: any) {
              if (je?.name !== "AbortError") {
                const a2 = document.createElement("a");
                a2.href = URL.createObjectURL(jsonBlob);
                a2.download = savedName + "_세션.json"; a2.click();
              }
            }
          }
        }
        return;
      } catch (e: any) {
        if (e?.name === "AbortError") return;
      }
    }
    const a1 = document.createElement("a");
    a1.href = URL.createObjectURL(docxBlob);
    a1.download = name + ".docx"; a1.click();
    if (withJson) {
      await new Promise<void>(resolve => setTimeout(() => {
        const a2 = document.createElement("a");
        a2.href = URL.createObjectURL(jsonBlob);
        a2.download = name + "_세션.json"; a2.click();
        setTimeout(resolve, 500);
      }, 300));
    }
  };

  const saveSessionJson = async (name: string) => {
    const sessionData = JSON.stringify({ version: 1, fileName, mode, rawText, lines, showTime });
    const jsonBlob = new Blob([sessionData], { type: "application/json;charset=utf-8" });
    if (hasFsApi) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: name + "_세션.json",
          types: [{ description: "세션 파일", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(jsonBlob);
        await writable.close();
        return;
      } catch (e: any) {
        if (e?.name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(jsonBlob);
    a.download = name + "_세션.json";
    a.click();
  };

  // ── 세션 불러오기 (JSON) ──────────────────────────────────────
  const loadSession = (f: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.version !== 1) { alert("지원하지 않는 세션 파일입니다."); return; }
        setFileName(data.fileName || "");
        setRawText(data.rawText || "");
        setLines(data.lines || []);
        setMode(data.mode || "raw");
        setShowTime(data.showTime || false);
        setLinesHistory([]);
        if (!localStorage.getItem("gb_hint_session_audio")) {
          setTimeout(() => {
            setContextHint({
              target: "btn-open-file",
              title: "음성 파일 불러오기 🎵",
              body: "파일 열기 → 재생만을 선택하면\n음성 파일을 불러와 들으면서\n텍스트를 편집할 수 있어요.",
              position: "bottom",
            });
            localStorage.setItem("gb_hint_session_audio", "1");
          }, 600);
        }
      } catch { alert("세션 파일을 읽을 수 없습니다."); }
    };
    reader.readAsText(f, "utf-8");
  };
  // ─────────────────────────────────────────────────────────────

  const progress = duration ? (current / duration) * 100 : 0;
  const visibleLines = filterSpeaker === "ALL" ? lines : lines.filter(l => l.speaker === filterSpeaker);
  const SPEAKER_TABS: { key: Speaker | "ALL"; label: string }[] = [
    { key: "ALL", label: "전체" }, { key: "C", label: "상" },
    { key: "P", label: "내" }, { key: "X", label: "제3자" }, { key: "E", label: "기타" },
  ];

  return (
    <div className="h-screen flex flex-col bg-[#f7f5f2] overflow-hidden relative">
      <audio ref={audioRef} src={audioUrl ?? undefined} />

      {/* ── Electron 전용 타이틀바 (맨 위 한 줄) ── */}
      {electronAPI && (
        <div
          className="flex items-center justify-end bg-white border-b border-gray-100 shrink-0"
          style={{ height: 32, WebkitAppRegion: "drag", paddingRight: 0 } as any}
        >
          <div style={{ WebkitAppRegion: "no-drag", display: "flex" } as any}>
            {/* 최소화 */}
            <button
              onClick={() => electronAPI.minimize()}
              title="최소화"
              style={{ width: 46, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", color: "#555" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#e5e5e5")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              <svg width="12" height="2" viewBox="0 0 12 2" fill="currentColor"><rect width="12" height="2" rx="1"/></svg>
            </button>
            {/* 최대화/복원 */}
            <button
              onClick={() => electronAPI.maximize()}
              title={isMaximized ? "창 복원" : "최대화"}
              style={{ width: 46, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", color: "#555" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#e5e5e5")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              {isMaximized ? (
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="0.75" width="7.25" height="7.25" rx="1"/>
                  <path d="M1 3v6.25a1 1 0 001 1H8"/>
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="0.75" y="0.75" width="9.5" height="9.5" rx="1"/>
                </svg>
              )}
            </button>
            {/* 닫기 */}
            <button
              onClick={() => setShowExitModal(true)}
              title="닫기"
              style={{ width: 46, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", color: "#555" }}
              onMouseEnter={e => { e.currentTarget.style.background = "#e81123"; e.currentTarget.style.color = "white"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#555"; }}
            >
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="1" y1="1" x2="10" y2="10"/>
                <line x1="10" y1="1" x2="1" y2="10"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── 상단 헤더 ── */}
      <header className="bg-white border-b border-gray-200 px-5 py-2.5 flex items-center justify-between shrink-0"
        style={{ WebkitAppRegion: electronAPI ? "drag" : "no-drag" } as any}>
        <div className="flex items-center gap-3" style={{ WebkitAppRegion: "no-drag" } as any}>
          <Logo size={36} />
          <div>
            <div className="font-bold text-[15px] text-[#2d1f0e] leading-tight" style={{fontFamily:"'Batang','바탕','serif'"}}>
              {userName ? `${userName}님의 곤글박이` : "곤글박이"}
            </div>
            {fileName
              ? <div className="text-[11px] text-gray-400 truncate max-w-[300px]">{fileName}</div>
              : <div className="text-[11px] text-gray-400">자동 음성 텍스트 변환기</div>
            }
          </div>
          {/* 탭 버튼 */}
          <div className="flex items-center gap-1 ml-4 bg-gray-100 rounded-lg p-1" data-tour="tabs">
            <button onClick={() => setActiveTab("transcribe")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                ${activeTab === "transcribe" ? "bg-white text-[#2d1f0e] shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
              축어록
            </button>
            <button onClick={() => setActiveTab("genogram")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                ${activeTab === "genogram" ? "bg-white text-[#2d1f0e] shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
              가계도
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5" style={{ WebkitAppRegion: "no-drag" } as any}>
          <Dialog open={openSettings} onOpenChange={setOpenSettings}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="w-8 h-8 ml-1" data-tour="settings-btn">
                <Settings className="w-4 h-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="flex flex-col" style={{ maxWidth: "880px", width: "95vw", maxHeight: "80vh" }}>
              <DialogHeader className="shrink-0">
                <DialogTitle className="flex items-center gap-2">
                  <Logo size={22} /> 곤글박이 설정
                </DialogTitle>
              </DialogHeader>

              {/* ── 2단 레이아웃 ── */}
              <div className="flex gap-5 flex-1 min-h-0 overflow-hidden px-1">

                {/* ── 왼쪽: 앱 소개 + 기부 안내 ── */}
                <div className="flex-1 min-w-0 overflow-y-auto pr-1 pl-0.5 space-y-3">

                  {/* 곤글박이란? */}
                  <div className="p-3 rounded-lg bg-gray-50 border border-gray-200">
                    <h3 className="font-bold text-gray-700 mb-1.5 text-xs">🪶 곤글박이란?</h3>
                    <p className="text-xs text-gray-600 leading-relaxed">
                      <b>곤글박이</b>는 '검은색 줄무늬가 박혀 있는 새'를 뜻하는 순우리말 새 이름 <b>곤줄박이</b>에서 따온 이름입니다.
                      '검은 글자(글)를 새긴다'는 뜻으로, 사용자의 소중한 기록을 새기는 프로그램이라는 의미를 담고 있습니다.
                    </p>
                  </div>

                  {/* 제작 의도 */}
                  <div className="p-3 rounded-lg bg-[#f0f7f2] border border-[#a8d8a8]">
                    <h3 className="font-bold text-[#2d7a3a] mb-1.5 text-xs flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5" /> 제작 의도
                    </h3>
                    <p className="text-xs text-gray-600 leading-relaxed">
                      상담 내용의 유출 가능성을 최소화하기 위해 <b>온디바이스(On-Device)</b> 방식으로 제작되었습니다.
                      음성 및 텍스트 데이터가 외부 서버로 전송되지 않으며, 모든 처리는 사용자의 PC 안에서만 이루어집니다.
                    </p>
                  </div>

                  {/* 사용 대상 */}
                  <div className="p-3 rounded-lg bg-gray-50 border border-gray-200">
                    <h3 className="font-bold text-gray-700 mb-1.5 text-xs">👥 사용 대상</h3>
                    <p className="text-xs text-gray-600 leading-relaxed">
                      보고서용 상담 축어록을 작성해야 하는 <b>상담학과 학생, 수련생, 상담사</b>를 위해 만들어졌습니다.
                    </p>
                  </div>

                  {/* 기부 안내 */}
                  <div className="p-3 rounded-lg bg-[#f0f7f2] border border-[#a8d8a8]">
                    <h3 className="font-bold text-[#2d7a3a] mb-1.5 text-xs flex items-center gap-1.5">
                      🌱 기부 안내
                    </h3>
                    <p className="text-xs text-gray-500 mb-2">이 프로그램(곤글박이)은 누구나 무료로 사용이 가능합니다. 이 프로그램이 마음에 드셨다면 주변의 어려운 이웃을 위해 작은 기부를 실천해 주시면 좋겠습니다. (아래 추천 기부처와 저는 아무런 관계가 없습니다.)</p>
                    <div className="text-xs font-bold text-gray-500 mb-1">[추천 기부처]</div>
                    <div className="space-y-1 text-xs">
                      {[
                        { label: "가톨릭중앙의료원 후원회사무국 발전기금팀", url: "https://www.ihappynanum.com/Nanum/api/4UHOKHOV5Y" },
                        { label: "(재)천주교한마음한몸운동본부", url: "https://ohob.or.kr/html/dh/do02" },
                        { label: "유니세프 (Unicef)", url: "https://www.unicef.or.kr/" },
                        { label: "네이버 해피빈 (온라인 기부 플랫폼)", url: "https://happybean.naver.com/donation/DonateHomeMain" },
                        { label: "사회복지공동모금회 (사랑의열매)", url: "https://chest.or.kr/base.do" },
                      ].map((d, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <span className="text-gray-400 shrink-0">•</span>
                          <a href={d.url} target="_blank" rel="noreferrer" className="text-[#3a6a4a] underline hover:text-[#2d5a3a]">{d.label}</a>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 설치 환경 안내 */}
                  <div className="p-3 rounded-lg bg-[#f7f5f2] border border-gray-200">
                    <h3 className="font-bold text-[#2d1f0e] mb-2 text-xs flex items-center gap-1.5">
                      <Cpu className="w-3.5 h-3.5 text-[#3a6a4a]" /> 설치 환경 안내
                    </h3>
                    <div className="space-y-2.5">
                      <div>
                        <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">최소 사양</div>
                        <div className="space-y-0.5 text-xs text-gray-600">
                          <div className="flex gap-2"><span className="w-24 shrink-0 text-gray-400">운영체제</span><span>Windows 10 이상</span></div>
                          <div className="flex gap-2"><span className="w-24 shrink-0 text-gray-400">메모리(RAM)</span><span>8GB 이상</span></div>
                          <div className="flex gap-2"><span className="w-24 shrink-0 text-gray-400">저장공간</span><span>3GB 이상 여유 공간</span></div>
                          <div className="flex gap-2"><span className="w-24 shrink-0 text-gray-400">인터넷</span><span>최초 1회 모델 다운로드 시에만 필요</span></div>
                        </div>
                      </div>
                      <div className="border-t border-gray-100 pt-2">
                        <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">권장 사양</div>
                        <div className="space-y-0.5 text-xs text-gray-600">
                          <div className="flex gap-2"><span className="w-24 shrink-0 text-gray-400">운영체제</span><span>Windows 10 / 11 (64비트)</span></div>
                          <div className="flex gap-2"><span className="w-24 shrink-0 text-gray-400">메모리(RAM)</span><span>16GB 이상</span></div>
                          <div className="flex gap-2"><span className="w-24 shrink-0 text-gray-400">저장공간</span><span>5GB 이상 여유 공간</span></div>
                          <div className="flex gap-2"><span className="w-24 shrink-0 text-gray-400">GPU</span><span>NVIDIA GPU (CUDA) — 변환 속도 5~10배 향상</span></div>
                        </div>
                      </div>
                      <div className="border-t border-gray-100 pt-2 space-y-1">
                        <div className="flex items-start gap-1.5 text-xs text-gray-500">
                          <ShieldCheck className="w-3 h-3 shrink-0 mt-0.5 text-[#3a6a4a]" />
                          <span>GPU 가속은 <b>NVIDIA GPU(CUDA)</b>를 사용하는 경우에만 적용됩니다.</span>
                        </div>
                        <div className="flex items-start gap-1.5 text-xs text-gray-500">
                          <Clock className="w-3 h-3 shrink-0 mt-0.5 text-[#3a6a4a]" />
                          <span>1시간 녹음 기준: CPU 약 30~60분 / NVIDIA GPU 약 5~10분</span>
                        </div>
                        <div className="flex items-start gap-1.5 text-xs text-gray-500">
                          <Cpu className="w-3 h-3 shrink-0 mt-0.5 text-[#3a6a4a]" />
                          <span>변환 모델: 속도 Small &gt; Medium &gt; Large-v3 / 정확도 반대</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 세로 구분선 */}
                <div className="w-px bg-gray-200 shrink-0 self-stretch" />

                {/* ── 오른쪽: 설정 + 탭(축어록/가계도) ── */}
                <div className="flex-1 min-w-0 overflow-y-auto px-1">

                  {/* 설정 항목들 */}
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">사용자 이름</Label>
                      <div className="px-2">
                        <Input value={tempName} onChange={e => setTempName(e.target.value)} placeholder="예: 홍길동" className="h-8 text-sm w-full" />
                      </div>
                      <p className="text-xs text-gray-400">상단에 표시됩니다.</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="flex items-center gap-1.5 text-xs"><Cpu className="w-3.5 h-3.5" /> 음성 변환 엔진 / 모델</Label>
                      <ModelManager
                        currentModel={model} onModelChange={setModel}
                        currentEngine={engine} onEngineChange={setEngine}
                      />
                      <p className="text-xs text-gray-400">GPU가 있으면 자동으로 사용합니다.</p>
                    </div>
                    <div className="flex items-center justify-between p-2.5 rounded-lg bg-gray-50">
                      <Label className="flex items-center gap-1.5 cursor-pointer text-xs">
                        <Clock className="w-3.5 h-3.5" /> 시간 표시
                        <span className="text-xs text-gray-400 ml-1">(기본: 꺼짐)</span>
                      </Label>
                      <button onClick={() => setShowTime(v => !v)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${showTime ? "bg-[#3a6a4a]" : "bg-gray-300"}`}>
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow ${showTime ? "translate-x-6" : "translate-x-1"}`} />
                      </button>
                    </div>
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-gray-50 text-xs text-gray-500">
                      <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-[#3a6a4a]" />
                      <span>모든 처리는 이 PC 안에서만 실행됩니다.<br />음성·텍스트 외부 전송 없음.</span>
                    </div>
                  </div>

                  {/* (설명은 별도 매뉴얼 버튼에서 확인) */}
                  <div style={{display:"none"}}>
                    <div className="overflow-y-auto flex-1 min-h-0 space-y-3 text-sm text-gray-700 pr-1">

                      {/* ── 축어록 설명 ── */}
                      {manualTab === "transcribe" && (<>
                        <div>
                          <h3 className="font-bold text-gray-700 mb-2 text-xs">🔘 버튼 기능</h3>
                          <div className="space-y-1.5">
                            {[
                              { icon: "📂", name: "파일 열기", desc: "음성 파일(mp3, wav, m4a 등)을 불러옵니다. 열면 자동으로 변환이 시작됩니다." },
                              { icon: "💾", name: "문서 저장", desc: "현재 편집 내용을 Word 문서(.docx)로 저장합니다. 세션 불러오기로 이전에 저장한 JSON 파일을 불러와 작업을 이어서 진행할 수 있습니다." },
                              { icon: "⚙️", name: "설정", desc: "사용자 이름, 변환 모델, 시간 표시 여부를 설정합니다." },
                              { icon: "▶️", name: "재생/정지", desc: "음성 파일을 재생하거나 정지합니다. Space 또는 Esc 키로도 조작 가능합니다." },
                              { icon: "⏪⏩", name: "앞으로/뒤로", desc: "음성을 10초 단위로 이동합니다. ← → 키로 3초씩 이동 가능합니다." },
                              { icon: "🔤", name: "화자 분리 시작", desc: "변환 완료 후 눌러주세요. 화자별로 편집할 수 있는 화면으로 전환됩니다." },
                              { icon: "↩️", name: "되돌리기", desc: "화자 편집 중 실수를 이전 상태로 되돌립니다. 최대 30단계까지 가능합니다." },
                            ].map(({ icon, name, desc }) => (
                              <div key={name} className="flex gap-2 p-2 rounded-lg bg-gray-50 border border-gray-100">
                                <span className="text-base shrink-0">{icon}</span>
                                <div>
                                  <div className="font-semibold text-gray-700 text-xs">{name}</div>
                                  <div className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">{desc}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <h3 className="font-bold text-gray-700 mb-2 text-xs">📋 사용 순서</h3>
                          <div className="space-y-1.5">
                            {[
                              "설정에서 사용자 이름과 변환 모델을 선택하세요.",
                              "파일 열기로 상담 녹음 파일을 불러옵니다.",
                              "자동으로 텍스트 변환이 시작되고 진행률이 표시됩니다.",
                              "변환 완료 후 텍스트를 확인하고 오타를 수정하세요.",
                              "화자 분리 시작을 눌러 상담사/내담자를 구분합니다.",
                              "Enter 키로 줄을 나누고, 화자 칩을 클릭해 전환합니다.",
                              "완료 후 문서 저장으로 축어록을 저장합니다.",
                            ].map((step, i) => (
                              <div key={i} className="flex gap-2 items-start">
                                <span className="shrink-0 w-5 h-5 rounded-full bg-[#3a6a4a] text-white text-[10px] flex items-center justify-center font-bold">{i + 1}</span>
                                <span className="text-gray-600 text-xs leading-relaxed pt-0.5">{step}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="p-3 rounded-lg bg-gray-50 border border-gray-200">
                          <h3 className="font-bold text-gray-700 mb-1.5 text-xs">⌨️ 단축키</h3>
                          <div className="space-y-1 text-xs text-gray-600">
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">Space / Esc</kbd><span>재생 / 정지</span></div>
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">← / →</kbd><span>3초 뒤로 / 앞으로</span></div>
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">Enter</kbd><span>줄 분할 + 화자 전환</span></div>
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">화자 칩 클릭</kbd><span>상담사 ↔ 내담자 ↔ 제3자 ↔ 기타</span></div>
                          </div>
                        </div>
                      </>)}

                      {/* ── 가계도 설명 ── */}
                      {manualTab === "genogram" && (<>
                        <div className="p-3 rounded-lg bg-[#f0f7f2] border border-[#a8d8a8]">
                          <h3 className="font-bold text-[#2d7a3a] mb-1.5 text-xs">🌳 가계도란?</h3>
                          <p className="text-xs text-gray-600 leading-relaxed">
                            가계도(Genogram)는 가족 구조와 구성원 간의 관계를 시각화하는 도구입니다. 상담 장면에서 내담자의 가족 역동을 파악하고 기록하는 데 활용됩니다.
                          </p>
                        </div>
                        <div>
                          <h3 className="font-bold text-gray-700 mb-2 text-xs">👤 인물 추가</h3>
                          <div className="space-y-1.5">
                            {[
                              { icon: "□", name: "남성", desc: "네모 도형. 상단 □ 버튼을 클릭해 추가합니다." },
                              { icon: "○", name: "여성", desc: "원형 도형. 상단 ○ 버튼을 클릭해 추가합니다." },
                              { icon: "◇", name: "논바이너리", desc: "마름모 도형. 상단 ◇ 버튼을 클릭해 추가합니다." },
                              { icon: "✕", name: "사망 토글", desc: "인물 선택 후 클릭 → X 표시(사망). 다시 클릭하면 해제됩니다." },
                              { icon: "⊡", name: "내담자 토글", desc: "인물 선택 후 클릭 → 이중 도형(내담자). 다시 클릭하면 해제됩니다." },
                            ].map(({ icon, name, desc }) => (
                              <div key={name} className="flex gap-2 p-2 rounded-lg bg-gray-50 border border-gray-100">
                                <span className="text-base shrink-0 w-5 text-center">{icon}</span>
                                <div>
                                  <div className="font-semibold text-gray-700 text-xs">{name}</div>
                                  <div className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">{desc}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <h3 className="font-bold text-gray-700 mb-2 text-xs">🔗 관계선 연결</h3>
                          <div className="space-y-1.5 text-xs text-gray-600">
                            <div className="p-2 rounded-lg bg-gray-50 border border-gray-100">
                              <div className="font-semibold text-gray-700 mb-1 text-xs">연결 방법</div>
                              <div className="space-y-0.5">
                                <div>① 상단 툴바에서 <b>선 종류</b>를 선택합니다</div>
                                <div>② 시작 인물을 <b>우클릭</b> → 연결 모드 전환</div>
                                <div>③ 연결할 인물을 <b>클릭</b>하면 선이 그어집니다</div>
                                <div>④ <b>Esc</b>를 누르면 연결 모드가 취소됩니다</div>
                              </div>
                            </div>
                            <div className="p-2 rounded-lg bg-gray-50 border border-gray-100">
                              <div className="font-semibold text-gray-700 mb-1 text-xs">선 종류</div>
                              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                                {[["가족관계","결혼/별거/이혼/동거"],["정서거리","소원/친밀/밀착/단절"],["갈등역동","갈등/융합된갈등"],["학대","신체적/성적학대"]].map(([cat, types]) => (
                                  <div key={cat}><span className="text-gray-400 font-semibold">{cat}</span><div className="text-gray-500">{types}</div></div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                        <div>
                          <h3 className="font-bold text-gray-700 mb-2 text-xs">👶 자녀 연결</h3>
                          <div className="p-2 rounded-lg bg-gray-50 border border-gray-100 text-[11px] text-gray-600 space-y-1">
                            <div><b>버튼:</b> 결혼/동거선 클릭 선택 → 상단 자녀 추가 버튼 → 자녀 클릭</div>
                            <div><b>우클릭:</b> 결혼/동거선 우클릭 → 자녀 인물 클릭</div>
                          </div>
                        </div>
                        <div>
                          <h3 className="font-bold text-gray-700 mb-2 text-xs">✏️ 편집</h3>
                          <div className="space-y-1.5">
                            {[
                              { icon: "✏️", name: "이름 편집", desc: "인물 도형 더블클릭 → 이름 입력 필드 활성화" },
                              { icon: "🔢", name: "나이 편집", desc: "도형 안 나이 텍스트 클릭 → 나이 입력" },
                              { icon: "🖱️", name: "이동", desc: "드래그로 위치 조정. Shift+클릭으로 다중 선택 후 함께 이동 가능합니다." },
                              { icon: "🗑️", name: "삭제", desc: "선택 후 Delete 키 또는 상단 삭제 버튼" },
                              { icon: "↩️", name: "되돌리기", desc: "Ctrl+Z 또는 상단 뒤로 버튼. 최대 30단계까지 가능합니다." },
                            ].map(({ icon, name, desc }) => (
                              <div key={name} className="flex gap-2 p-2 rounded-lg bg-gray-50 border border-gray-100">
                                <span className="text-base shrink-0">{icon}</span>
                                <div>
                                  <div className="font-semibold text-gray-700 text-xs">{name}</div>
                                  <div className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">{desc}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="p-3 rounded-lg bg-gray-50 border border-gray-200">
                          <h3 className="font-bold text-gray-700 mb-1.5 text-xs">⌨️ 단축키</h3>
                          <div className="space-y-1 text-xs text-gray-600">
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">우클릭 (인물)</kbd><span>연결 모드 시작</span></div>
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">우클릭 (결혼선)</kbd><span>자녀 연결 모드</span></div>
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">더블클릭</kbd><span>이름 편집</span></div>
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">Shift + 클릭</kbd><span>다중 선택</span></div>
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">Delete</kbd><span>선택 항목 삭제</span></div>
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">Ctrl + Z</kbd><span>되돌리기</span></div>
                            <div className="flex gap-2"><kbd className="px-1.5 py-0.5 bg-white border rounded font-mono text-[10px]">Esc</kbd><span>선택 해제 / 연결 취소</span></div>
                          </div>
                        </div>
                        <div className="p-2.5 rounded-lg bg-[#f7f5f2] border border-gray-200 text-[11px] text-gray-500">
                          <b>💡 저장 팁:</b> 완성된 가계도는 상단 <b>SVG 저장</b> 버튼으로 이미지 파일로 내보낼 수 있습니다.
                        </div>
                      </>)}

                    </div>
                  </div>

                </div>
              </div>

              <DialogFooter className="shrink-0 pt-3 border-t border-gray-100">
                <div className="flex items-center justify-between w-full gap-3">
                  <p className="text-[11px] text-gray-400 font-semibold shrink-0 text-right leading-tight">© 2026. An In-song. Distributed for free.<br />(2026. 안인성. 무료 배포)</p>
                  <Button onClick={() => { setUserName(tempName.trim()); setOpenSettings(false); }}
                    className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white shrink-0">저장</Button>
                </div>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* 매뉴얼 버튼 */}
          <Dialog open={openManual} onOpenChange={setOpenManual}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="w-8 h-8">
                <BookOpen className="w-4 h-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg flex flex-col" style={{ maxHeight: "85vh" }}>
              <DialogHeader className="shrink-0">
                <DialogTitle className="flex items-center gap-2">
                  <Logo size={22} /> 곤글박이 사용 설명서
                </DialogTitle>
              </DialogHeader>

              {/* 탭 선택 */}
              <div className="flex gap-1 bg-gray-100 rounded-lg p-1 shrink-0">
                <button onClick={() => setManualTab("transcribe")}
                  className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors
                    ${manualTab === "transcribe" ? "bg-white text-[#2d1f0e] shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                  📝 축어록
                </button>
                <button onClick={() => setManualTab("genogram")}
                  className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors
                    ${manualTab === "genogram" ? "bg-white text-[#2d1f0e] shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                  🌳 가계도
                </button>
              </div>

              {/* 탭 내용 - 스크롤 영역 */}
              <div className="overflow-y-auto flex-1 min-h-0">

                {/* ── 축어록 탭 ── */}
                {manualTab === "transcribe" && (
                  <div className="space-y-4 py-2 text-sm text-gray-700">

                    <div className="p-4 rounded-lg bg-[#f0f7f2] border border-[#a8d8a8]">
                      <h3 className="font-bold text-[#2d7a3a] mb-2">📝 축어록이란?</h3>
                      <p className="leading-relaxed text-gray-600">
                        상담 과정에서 오고 간 모든 발화를 그대로 적어, 상담의 흐름과 정서를 객관적으로 점검할 수 있게 만든 기록물입니다. 대화 내용뿐 아니라 중단, 반복, 침묵, 표정, 몸짓 등 비언어적 요소를 함께 기록해 상담의 의미를 더 정확히 파악하려는 목적이 있습니다.
                      </p>
                    </div>

                    <div>
                      <h3 className="font-bold text-gray-700 mb-3">🔘 버튼 기능 설명</h3>
                      <div className="space-y-2">
                        {[
                          { icon: "📂", name: "파일 열기", desc: "음성 파일(mp3, wav, m4a 등)을 불러옵니다. 파일을 열면 자동으로 텍스트 변환이 시작됩니다." },
                          { icon: "💾", name: "문서 저장", desc: "현재 편집된 내용을 Word 문서(.docx)로 저장합니다. 한글(HWP)에서 열어 붙여넣기도 가능합니다. 세션 불러오기로 이전에 저장한 JSON 파일을 불러와 작업을 이어서 진행할 수 있습니다." },
                          { icon: "⚙️", name: "설정", desc: "사용자 이름, 음성 변환 모델(Small/Medium/Large), 시간 표시 여부를 설정합니다." },
                          { icon: "▶️", name: "재생/정지", desc: "불러온 음성 파일을 재생하거나 정지합니다. ⇧Space 또는 Esc 키로도 조작 가능합니다." },
                          { icon: "⏪⏩", name: "앞으로/뒤로", desc: "음성을 10초 단위로 앞뒤로 이동합니다. ⇧← ⇧→ 키로도 3초씩 이동 가능합니다." },
                          { icon: "🔤", name: "화자 분리 시작", desc: "텍스트 변환이 완료된 후 눌러주세요. 줄글을 화자별로 나눌 수 있는 편집 화면으로 전환됩니다." },
                          { icon: "↩️", name: "되돌리기", desc: "화자 분리 편집 중 실수로 수정한 내용을 이전 상태로 되돌립니다. 최대 30단계까지 가능합니다." },
                        ].map(({ icon, name, desc }) => (
                          <div key={name} className="flex gap-3 p-3 rounded-lg bg-gray-50 border border-gray-100">
                            <span className="text-lg shrink-0">{icon}</span>
                            <div>
                              <div className="font-semibold text-gray-700">{name}</div>
                              <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <h3 className="font-bold text-gray-700 mb-3">📋 사용 순서</h3>
                      <div className="space-y-2">
                        {[
                          "설정에서 사용자 이름과 변환 모델을 선택하세요.",
                          "파일 열기로 상담 녹음 파일을 불러옵니다.",
                          "자동으로 텍스트 변환이 시작되고 하단에 진행률이 표시됩니다.",
                          "변환 완료 후 텍스트를 확인하고 오타를 수정하세요.",
                          "화자 분리 시작을 눌러 상담사/내담자를 구분합니다.",
                          "Enter 키로 줄을 나누고, 화자 칩을 클릭해 상↔내↔제3자를 전환합니다.",
                          "완료 후 문서 저장으로 축어록을 저장합니다.",
                        ].map((step, i) => (
                          <div key={i} className="flex gap-3 items-start">
                            <span className="shrink-0 w-6 h-6 rounded-full bg-[#3a6a4a] text-white text-xs flex items-center justify-center font-bold">{i + 1}</span>
                            <span className="text-gray-600 text-sm leading-relaxed pt-0.5">{step}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="p-4 rounded-lg bg-gray-50 border border-gray-200">
                      <h3 className="font-bold text-gray-700 mb-2">⌨️ 단축키</h3>
                      <div className="space-y-1 text-xs text-gray-600">
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">⇧Space / Esc</kbd><span>재생 / 정지 (편집 중에도 작동)</span></div>
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">⇧← / ⇧→</kbd><span>3초 뒤로 / 앞으로 (편집 중에도 작동)</span></div>
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">Enter</kbd><span>커서 위치에서 줄 분할 + 화자 전환</span></div>
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">화자 칩 클릭</kbd><span>상담사 ↔ 내담자 ↔ 제3자 ↔ 기타 전환</span></div>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── 가계도 탭 ── */}
                {manualTab === "genogram" && (
                  <div className="space-y-4 py-2 text-sm text-gray-700">

                    <div className="p-4 rounded-lg bg-[#f0f7f2] border border-[#a8d8a8]">
                      <h3 className="font-bold text-[#2d7a3a] mb-2">🌳 가계도란?</h3>
                      <p className="leading-relaxed text-gray-600">
                        가계도(Genogram)는 가족 구조와 구성원 간의 관계를 시각화하는 도구입니다. 상담 장면에서 내담자의 가족 역동을 파악하고 기록하는 데 활용됩니다.
                      </p>
                    </div>

                    <div>
                      <h3 className="font-bold text-gray-700 mb-3">👤 인물 추가</h3>
                      <div className="space-y-2">
                        {[
                          { icon: "□", name: "남성", desc: "네모 도형으로 표시됩니다. 상단 툴바의 □ 버튼을 클릭해 추가합니다." },
                          { icon: "○", name: "여성", desc: "원형 도형으로 표시됩니다. 상단 툴바의 ○ 버튼을 클릭해 추가합니다." },
                          { icon: "◇", name: "논바이너리", desc: "마름모 도형으로 표시됩니다. 상단 툴바의 ◇ 버튼을 클릭해 추가합니다." },
                          { icon: "✕", name: "사망 토글", desc: "인물을 선택한 후 클릭하면 도형 안에 X 표시가 생겨 사망을 나타냅니다. 다시 클릭하면 해제됩니다." },
                          { icon: "⊡", name: "내담자 토글", desc: "인물을 선택한 후 클릭하면 이중 도형으로 표시되어 내담자임을 나타냅니다. 다시 클릭하면 해제됩니다." },
                        ].map(({ icon, name, desc }) => (
                          <div key={name} className="flex gap-3 p-3 rounded-lg bg-gray-50 border border-gray-100">
                            <span className="text-lg shrink-0 w-6 text-center">{icon}</span>
                            <div>
                              <div className="font-semibold text-gray-700">{name}</div>
                              <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <h3 className="font-bold text-gray-700 mb-3">🔗 관계선 연결</h3>
                      <div className="space-y-2 text-xs text-gray-600">
                        <div className="p-3 rounded-lg bg-gray-50 border border-gray-100">
                          <div className="font-semibold text-gray-700 mb-1">연결 방법</div>
                          <div className="space-y-1">
                            <div>① 상단 툴바에서 연결할 <b>선 종류</b>를 선택합니다 (결혼·소원·갈등 등)</div>
                            <div>② 시작 인물을 <b>우클릭</b>하면 연결 모드로 전환됩니다</div>
                            <div>③ 연결할 상대 인물을 <b>클릭</b>하면 선이 그어집니다</div>
                            <div>④ <b>Esc</b>를 누르면 연결 모드가 취소됩니다</div>
                          </div>
                        </div>
                        <div className="p-3 rounded-lg bg-gray-50 border border-gray-100">
                          <div className="font-semibold text-gray-700 mb-1.5">선 종류</div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                            {[
                              ["가족관계", "결혼 / 별거 / 이혼 / 동거"],
                              ["정서거리", "소원 / 친밀 / 밀착 / 단절"],
                              ["갈등역동", "갈등 / 융합된갈등"],
                              ["학대", "신체적학대 / 성적학대"],
                            ].map(([cat, types]) => (
                              <div key={cat}>
                                <span className="text-gray-400 font-semibold">{cat}</span>
                                <div className="text-gray-500">{types}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h3 className="font-bold text-gray-700 mb-3">👶 자녀 연결</h3>
                      <div className="p-3 rounded-lg bg-gray-50 border border-gray-100 text-xs text-gray-600 space-y-1.5">
                        <div><b>방법 1 — 버튼:</b> 결혼/동거선을 클릭해 선택 → 상단 <b>자녀 추가</b> 버튼 클릭 → 자녀 인물 클릭</div>
                        <div><b>방법 2 — 우클릭:</b> 결혼/동거선을 <b>우클릭</b> → 자녀 인물 클릭</div>
                        <div className="text-gray-400 pt-1">자녀선은 부모 관계선 중앙에서 수직으로 내려와 자녀 도형에 연결됩니다.</div>
                      </div>
                    </div>

                    <div>
                      <h3 className="font-bold text-gray-700 mb-3">✏️ 편집</h3>
                      <div className="space-y-2">
                        {[
                          { icon: <Pencil className="w-4 h-4 text-gray-500" />, name: "이름 편집", desc: "인물 도형을 더블클릭하면 도형 아래 이름 입력 필드가 활성화됩니다." },
                          { icon: <span className="text-lg">🔢</span>, name: "나이 편집", desc: "도형 안의 나이 텍스트를 클릭하면 나이를 입력할 수 있습니다." },
                          { icon: <span className="text-lg">🖱️</span>, name: "이동", desc: "인물을 드래그해서 위치를 조정합니다. 여러 명을 Shift+클릭으로 선택 후 함께 이동할 수 있습니다." },
                          { icon: <span className="text-lg">🗑️</span>, name: "삭제", desc: "인물이나 선을 선택 후 Delete 키 또는 상단의 삭제 버튼으로 삭제합니다." },
                          { icon: <span className="text-lg">↩️</span>, name: "되돌리기", desc: "Ctrl+Z 또는 상단 뒤로 버튼으로 최대 30단계까지 되돌릴 수 있습니다." },
                        ].map(({ icon, name, desc }) => (
                          <div key={name} className="flex gap-3 p-3 rounded-lg bg-gray-50 border border-gray-100">
                            <span className="shrink-0 w-6 flex items-center justify-center mt-0.5">{icon}</span>
                            <div>
                              <div className="font-semibold text-gray-700">{name}</div>
                              <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="p-4 rounded-lg bg-gray-50 border border-gray-200">
                      <h3 className="font-bold text-gray-700 mb-2">⌨️ 단축키</h3>
                      <div className="space-y-1 text-xs text-gray-600">
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">우클릭 (인물)</kbd><span>연결 모드 시작</span></div>
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">우클릭 (결혼·동거선)</kbd><span>자녀 연결 모드</span></div>
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">더블클릭</kbd><span>이름 편집</span></div>
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">Shift + 클릭</kbd><span>다중 선택</span></div>
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">드래그 (빈 공간)</kbd><span>범위 선택</span></div>
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">Delete</kbd><span>선택 항목 삭제</span></div>
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">Ctrl + Z</kbd><span>되돌리기</span></div>
                        <div className="flex gap-2"><kbd className="px-2 py-0.5 bg-white border rounded font-mono">Esc</kbd><span>선택 해제 / 연결 취소</span></div>
                      </div>
                    </div>

                    <div className="p-3 rounded-lg bg-[#f7f5f2] border border-gray-200 text-xs text-gray-500">
                      <b>💡 저장 팁:</b> 완성된 가계도는 상단 <b>SVG 저장</b> 버튼으로 이미지 파일로 내보낼 수 있습니다. SVG 파일은 벡터 형식이라 확대해도 선명하게 유지됩니다.
                    </div>

                  </div>
                )}

              </div>

              <DialogFooter className="shrink-0">
                <div className="flex items-center justify-between w-full gap-3">
                  <p className="text-[11px] text-gray-400 font-semibold shrink-0 text-right leading-tight">© 2026. An In-song. Distributed for free.<br />(2026. 안인성. 무료 배포)</p>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => window.open("http://127.0.0.1:5577/help.html", "_blank")}
                      className="text-sm font-medium text-[#3a6a4a] hover:underline shrink-0 border border-[#3a6a4a] rounded-md px-3 py-1.5">
                      🔧 문제가 생겼나요?
                    </button>
                    <Button onClick={() => setOpenManual(false)} className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white shrink-0">닫기</Button>
                  </div>
                </div>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1 px-2" data-tour="help-btn"
            onClick={() => window.open("http://127.0.0.1:5577/help.html", "_blank")}>
            🔧 문제해결
          </Button>
          <Button variant="ghost" size="icon" className="w-8 h-8" title="사용 안내 투어"
            onClick={() => activeTab === "genogram" ? setGeoTourStep(0) : setTourStep(0)}>
            <HelpCircle className="w-4 h-4" />
          </Button>
          {/* 디버그 파일 복사 버튼 */}
          <Button variant="ghost" size="icon" className="w-8 h-8" title="디버그 로그 복사" data-tour="debug-btn"
            onClick={async () => {
              try {
                const res = await fetch("http://127.0.0.1:5577/api/debug-log");
                const data = await res.json();
                await navigator.clipboard.writeText(data.content);
                alert("디버그 파일이 클립보드에 복사됐어요!\n문의 시 붙여넣기(Ctrl+V)해서 보내주세요.");
              } catch {
                alert("복사에 실패했어요. %USERPROFILE%\\gongulbaki_debug.txt 파일을 직접 열어주세요.");
              }
            }}>
            📋
          </Button>
        </div>
      </header>

      {/* ── 새 작업 시작 모달 ── */}
      {showNewRecordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl px-8 py-7 flex flex-col gap-4 w-[340px]">
            <div>
              <p className="font-bold text-[15px] text-gray-800 mb-1">✅ 저장이 완료됐어요!</p>
              <p className="text-xs text-gray-500 leading-relaxed">새 작업을 시작하시겠어요?<br />현재 내용은 모두 지워집니다.</p>
            </div>
            <div className="flex flex-col gap-2">
              <Button
                className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white w-full h-11 text-sm"
                onClick={() => { setShowNewRecordModal(false); newRecord(); }}>
                새 작업 시작
              </Button>
              <Button variant="outline" className="w-full h-11 text-sm"
                onClick={() => setShowNewRecordModal(false)}>
                계속 편집
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── 오류 메시지 배너 (converting 상태와 별개로 유지) ── */}
      {!converting && errorMsg && (
        <div className="bg-red-50 border-b border-red-200 px-5 py-2.5 flex items-center gap-3 shrink-0">
          <span className="text-lg shrink-0">⚠️</span>
          <p className="flex-1 text-sm text-red-700 leading-relaxed">{errorMsg}</p>
          <button
            onClick={() => setErrorMsg("")}
            className="shrink-0 text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded">
            닫기
          </button>
        </div>
      )}

      {/* ── 파일 선택 모달: 재생만 할지 변환할지 ── */}
      {/* ── 세션 저장 확인 모달 ── */}
      {showSessionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl px-8 py-7 flex flex-col gap-4 w-[360px]">
            <div>
              <p className="font-bold text-[15px] text-gray-800 mb-2">💾 문서 저장</p>
              <p className="text-xs text-gray-500 leading-relaxed">
                저장 형식을 선택해주세요.<br />
                <b>JSON</b>으로 저장하면 나중에 <b>세션 열기</b>로 불러와<br />
                이어서 편집할 수 있습니다.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button
                className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white w-full h-11 text-sm"
                onClick={() => {
                  setShowSessionModal(false);
                  if (pendingSaveDocxBlob) doSaveDocx(pendingSaveDocxBlob, pendingSaveName, false).then(() => setShowNewRecordModal(true));
                }}>
                📄 워드 저장 (.docx)
              </Button>
              <Button variant="outline" className="w-full h-11 text-sm border-[#3a6a4a] text-[#3a6a4a] hover:bg-[#f0f7f2]"
                onClick={() => {
                  setShowSessionModal(false);
                  saveSessionJson(pendingSaveName).then(() => setShowNewRecordModal(true));
                }}>
                📋 JSON 파일 저장 <span className="text-[10px] text-gray-400 ml-1">✏️ 수정 가능</span>
              </Button>
            </div>
            <button onClick={() => setShowSessionModal(false)}
              className="text-xs text-gray-400 hover:text-gray-600 text-center mt-1">취소</button>
          </div>
        </div>
      )}

      {pendingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl px-8 py-7 flex flex-col gap-4 w-[340px]">
            <div>
              <p className="font-bold text-[15px] text-gray-800 mb-1">파일을 어떻게 열까요?</p>
              <p className="text-xs text-gray-400 truncate">{pendingFile.name}</p>
            </div>
            <div className="flex flex-col gap-2">
              <Button
                className="bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white w-full justify-start gap-2 h-12 text-sm"
                onClick={() => { onFile(pendingFile); setPendingFile(null); }}>
                <Cpu className="w-4 h-4 shrink-0" />
                <div className="text-left"><div className="font-bold">텍스트 변환 + 재생</div><div className="text-[11px] opacity-80">음성 → 텍스트 변환 후 편집</div></div>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2 h-12 text-sm"
                onClick={() => { loadAudio(pendingFile); setPendingFile(null); }}>
                <Play className="w-4 h-4 shrink-0" />
                <div className="text-left"><div className="font-bold">재생만</div><div className="text-[11px] text-gray-400">변환 없이 음성만 듣기</div></div>
              </Button>
            </div>
            <button onClick={() => setPendingFile(null)} className="text-xs text-gray-400 hover:text-gray-600 text-center mt-1">취소</button>
          </div>
        </div>
      )}

      {/* ── 축어록 전용 툴바 ── */}
      {activeTab === "transcribe" && (
        <div className="bg-white border-b border-gray-200 px-5 py-2 flex items-center gap-1.5 shrink-0">

          {/* split 모드: 화자 필터 왼쪽 */}
          {mode === "split" && (
            <div className="flex items-center gap-1.5">
              {SPEAKER_TABS.map(({ key, label }) => {
                const col = key !== "ALL" ? speakerColor(key as Speaker) : null;
                const active = filterSpeaker === key;
                return (
                  <button key={key} onClick={() => setFilterSpeaker(key)}
                    className="px-3 py-1 rounded-full text-xs font-medium transition-all border"
                    style={active && col
                      ? { background: col.bg, color: col.text, borderColor: col.border }
                      : active
                      ? { background: "#ececec", color: "#444", borderColor: "#ccc" }
                      : { background: "white", color: "#999", borderColor: "#e5e5e5" }}>
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {/* 파일/세션 버튼 + 모드 버튼 — 항상 오른쪽 정렬 */}
          <div className="ml-auto flex items-center gap-1.5">
            <label data-tour="btn-open-file">
              <input type="file" accept="audio/*" className="hidden"
                onChange={e => e.target.files?.[0] && onFileSelect(e.target.files[0])} />
              <Button variant="outline" size="sm" asChild>
                <span className="cursor-pointer gap-1"><Upload className="w-3.5 h-3.5" /> 파일 열기</span>
              </Button>
            </label>
            <Button variant="outline" size="sm" onClick={newRecord} className="gap-1">
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3v10M3 8h10"/></svg>
              새 작업
            </Button>
            <label title="세션 불러오기 (.json)" data-tour="btn-open-session">
              <input type="file" accept=".json" className="hidden"
                onChange={e => e.target.files?.[0] && loadSession(e.target.files[0])} />
              <Button variant="outline" size="sm" asChild>
                <span className="cursor-pointer gap-1">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 10v3h12v-3M8 2v8M5 7l3 3 3-3"/></svg>
                  세션 열기
                </span>
              </Button>
            </label>
            <Button size="sm" onClick={exportDocx} data-tour="btn-save"
              className="gap-1 bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white border-0">
              <Save className="w-3.5 h-3.5" /> 문서 저장
            </Button>

            <div className="h-4 w-px bg-gray-200 mx-1" />

            {/* raw 모드: 화자분리 시작 */}
            {mode === "raw" && (
              <Button size="sm" onClick={startSplitting} disabled={!rawText.trim()} data-tour="btn-split"
                className="gap-1 bg-[#3a6a4a] hover:bg-[#2d5a3a] text-white border-0">
                화자 분리 시작 →
              </Button>
            )}

            {/* split 모드: 줄글로 + 되돌리기 */}
            {mode === "split" && (
              <>
                <Button size="sm" variant="outline" onClick={() => setMode("raw")} className="text-xs">
                  ← 줄글로
                </Button>
                <Button size="sm" variant="outline" onClick={undoLines}
                  disabled={linesHistory.length === 0} data-tour="btn-undo"
                  className="text-xs gap-1" title="실행 취소 (Undo)">
                  <Undo2 className="w-3.5 h-3.5" /> 되돌리기
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── 이어하기 배너 ── */}
      {activeTab === "transcribe" && resumeBanner && (
        <div className="bg-amber-50 border-b border-amber-200 px-5 py-3 flex items-center gap-3 shrink-0">
          <span className="text-xl shrink-0">⚠️</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-amber-800">이전 변환이 중단되었습니다</p>
            <p className="text-xs text-amber-600 truncate mt-0.5">
              📄 {resumeBanner.fileName} · <span className="font-semibold">{resumeBanner.progress}%</span> 까지 변환됨
            </p>
            <p className="text-xs text-amber-500 mt-0.5">
              {resumeBanner.blob ? "파일 선택 없이 중단된 지점부터 바로 이어서 변환합니다." : "같은 파일을 선택하면 중단된 지점부터 이어서 변환합니다."}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {resumeBanner.blob ? (
              /* blob 있음 → 파일 선택 없이 바로 이어받기 */
              <button
                onClick={() => {
                  const file = new File([resumeBanner.blob!], resumeBanner.fileName, { type: resumeBanner.blob!.type });
                  onFile(file, { text: resumeBanner.text, startSec: resumeBanner.startSec, progress: resumeBanner.progress });
                }}
                className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold transition-colors">
                ▶ 이어서 변환
              </button>
            ) : (
              /* blob 없음(재부팅 등) → 파일 직접 선택 */
              <label className="cursor-pointer">
                <input type="file" accept="audio/*" className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    onFile(file, { text: resumeBanner.text, startSec: resumeBanner.startSec, progress: resumeBanner.progress });
                  }} />
                <span className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold transition-colors inline-block">
                  🎵 파일 선택 후 이어서 변환
                </span>
              </label>
            )}
            <button
              onClick={() => {
                if (window.confirm("이어받기를 취소하면 지금까지 변환된 내용이 초기화됩니다.\n정말 취소하시겠습니까?")) {
                  setResumeBanner(null);
                  setRawText("");
                  localStorage.removeItem("gb_convert_progress");
                  clearAudioFromDB().catch(() => {});
                }
              }}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-white hover:bg-red-50 text-red-400 hover:text-red-600 text-xs border border-gray-200 transition-colors">
              ✕ 취소 (초기화)
            </button>
          </div>
        </div>
      )}

      {/* ── 편집 영역 ── */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {/* 가계도 탭 - 항상 마운트, display:none으로 상태 유지 */}
        <div style={{ display: activeTab === "genogram" ? "flex" : "none" }} className="flex-1 flex-col min-h-0 overflow-hidden">
          <Genogram />
        </div>

        {/* 축어록 탭 - 항상 마운트, display:none으로 상태 유지 */}
        <div style={{ display: activeTab === "transcribe" ? "flex" : "none" }} className="flex-1 flex-col min-h-0 overflow-hidden">
          {mode === "raw" ? (
            <div className="flex-1 flex flex-col p-4 gap-2 min-h-0">
              <div className="shrink-0">
                <p className="text-xs text-gray-400">
                  변환 결과를 확인하고 오타를 수정하세요. 완료 후 <b>화자 분리 시작</b>을 누르세요.
                </p>
              </div>
              <textarea value={rawText} onChange={e => setRawText(e.target.value)}
                className="flex-1 w-full p-5 rounded-xl border border-gray-200 bg-white leading-relaxed text-[15px] outline-none resize-none shadow-sm"
                placeholder="파일을 선택하면 변환 결과가 이곳에 실시간으로 채워집니다…" />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-2 min-h-full overflow-hidden">
                {visibleLines.map((l) => {
                  const col = speakerColor(l.speaker);
                  const tag = speakerLabel(l.speaker, l.index);
                  return (
                    <div key={l.id} className="group flex items-start gap-2">
                      <button onClick={() => cycleSpeaker(l.id)}
                        className="shrink-0 w-12 h-7 rounded-full text-xs font-bold transition-all hover:scale-105 border mt-1"
                        style={{ background: col.bg, color: col.text, borderColor: col.border }}>
                        {tag}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div contentEditable suppressContentEditableWarning data-line-id={l.id}
                          onKeyDown={e => handleSplitKey(e, l.id)}
                          onBlur={e => updateText(l.id, e.currentTarget.textContent || "")}
                          className="min-h-[1.8rem] px-3 py-1 rounded-lg leading-relaxed text-[15px] outline-none transition-colors break-words"
                          style={{ background: col.bg + "55", borderLeft: `3px solid ${col.border}`, wordBreak: "break-word", overflowWrap: "break-word" }}>
                          {l.text}
                        </div>
                      </div>
                      {showTime && (
                        <button onClick={() => seekTo(l.time)}
                          className="shrink-0 text-[10px] font-mono text-gray-400 hover:text-gray-600 mt-1.5">
                          {fmt(l.time)}
                        </button>
                      )}
                    </div>
                  );
                })}
                {lines.length === 0 && (
                  <p className="text-sm text-gray-400 py-16 text-center">줄글로 돌아가서 다시 시작해 보세요.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 하단 플레이어 (축어록 탭에서만) ── */}
      {activeTab === "transcribe" && (
      <div className="bg-white border-t border-gray-200 shrink-0" data-tour="player">
        {/* 변환 진행 바 - 플레이어 바로 위 */}
        {converting && (
          <div className="flex items-center gap-3 px-5 py-1.5 bg-[#f7f5f0] border-b border-gray-100">
            <span className="text-[11px] text-gray-500 shrink-0 min-w-[160px]">{convertStatus}</span>
            <div className="flex-1 bg-gray-200 rounded-full h-1 overflow-hidden">
              <div className="h-full rounded-full transition-all duration-500"
                style={{ width: `${convertProgress}%`, background: "linear-gradient(90deg,#c8a84b,#f0d080)" }} />
            </div>
            <span className="text-[11px] text-gray-400 font-mono w-8 text-right shrink-0">{convertProgress}%</span>
            <button onClick={cancelConvert}
              className="shrink-0 text-xs text-gray-400 hover:text-red-500 hover:bg-red-50 px-2 py-0.5 rounded transition-colors border border-gray-200">
              취소
            </button>
          </div>
        )}
        {/* 1행: 컨트롤 + 속도 + 단축키 + 저작권 */}
        <div className="px-5 pt-2.5 pb-1 flex items-center gap-3">
          {/* 컨트롤 버튼 */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={() => seek(-10)}
              className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center">
              <SkipBack className="w-3.5 h-3.5 text-gray-600" />
            </button>
            <button onClick={togglePlay}
              className="w-10 h-10 rounded-full flex items-center justify-center shadow"
              style={{ background: "linear-gradient(135deg,#3a6a4a,#5a9a6a)" }}>
              {playing
                ? <Pause className="w-4.5 h-4.5 text-white" />
                : <Play className="w-4.5 h-4.5 text-white ml-0.5" />}
            </button>
            <button onClick={() => seek(10)}
              className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center">
              <SkipForward className="w-3.5 h-3.5 text-gray-600" />
            </button>
          </div>

          {/* 속도 */}
          <div className="flex items-center gap-1 shrink-0">
            {[0.75, 1, 1.25, 1.5].map(r => (
              <button key={r} onClick={() => setRate(r)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors font-medium ${rate === r ? "bg-[#3a6a4a] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                {r}x
              </button>
            ))}
          </div>

          {/* 단축키 안내 */}
          <div className="hidden lg:flex flex-1 items-center gap-2 text-[11px] text-gray-500 font-medium min-w-0">
            <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">⇧Space / Esc</kbd> 재생/정지</span>
            <span className="text-gray-300">|</span>
            <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">⇧←/→</kbd> 3초 이동</span>
            <span className="text-gray-300">|</span>
            <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">Enter</kbd> 분할+화자전환</span>
            <span className="text-gray-300">|</span>
            <span className="whitespace-nowrap"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[10px] font-semibold">화자칩</kbd> 상↔내↔제3자</span>
          </div>

          {/* 저작권 - 항상 표시 */}
          <span className="ml-auto font-semibold shrink-0 text-right leading-tight text-[11px] text-gray-500 whitespace-nowrap">
            © 2026. An In-song. Distributed for free.<br />(2026. 안인성. 무료 배포)
          </span>
        </div>

        {/* 2행: 진행바 */}
        <div className="px-5 pb-2.5 flex items-center gap-2.5">
          <span className="text-xs font-mono text-gray-500 shrink-0">{fmt(current)}</span>
          <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden cursor-pointer"
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect();
              if (audioRef.current) audioRef.current.currentTime = ((e.clientX - r.left) / r.width) * (audioRef.current.duration || 0);
            }}>
            <div className="h-full rounded-full transition-all"
              style={{ width: `${progress}%`, background: "linear-gradient(90deg,#3a6a4a,#5a9a6a)" }} />
          </div>
          <span className="text-xs font-mono text-gray-500 shrink-0">{fmt(duration)}</span>
        </div>
      </div>
      )}

      {/* ── 상황별 힌트 ── */}
      {contextHint && tourStep < 0 && (
        <ContextHint hint={contextHint} onClose={() => setContextHint(null)} />
      )}

      {/* ── 축어록 투어 ── */}
      {tourStep >= 0 && tourStep < TOUR_STEPS.length && (
        <TourOverlay
          step={TOUR_STEPS[tourStep]}
          stepIndex={tourStep}
          total={TOUR_STEPS.length}
          onNext={() => {
            if (tourStep >= TOUR_STEPS.length - 1) {
              localStorage.setItem("gb_tour_done", "1");
              setTourStep(-1);
            } else {
              setTourStep(s => s + 1);
            }
          }}
          onPrev={() => setTourStep(s => Math.max(0, s - 1))}
          onClose={() => { localStorage.setItem("gb_tour_done", "1"); setTourStep(-1); }}
        />
      )}

      {/* ── 가계도 투어 ── */}
      {geoTourStep >= 0 && geoTourStep < GENOGRAM_TOUR_STEPS.length && (
        <TourOverlay
          step={GENOGRAM_TOUR_STEPS[geoTourStep]}
          stepIndex={geoTourStep}
          total={GENOGRAM_TOUR_STEPS.length}
          onNext={() => {
            if (geoTourStep >= GENOGRAM_TOUR_STEPS.length - 1) {
              localStorage.setItem("gb_geo_tour_done", "1");
              setGeoTourStep(-1);
            } else {
              setGeoTourStep(s => s + 1);
            }
          }}
          onPrev={() => setGeoTourStep(s => Math.max(0, s - 1))}
          onClose={() => { localStorage.setItem("gb_geo_tour_done", "1"); setGeoTourStep(-1); }}
        />
      )}

      {/* ── 종료 확인 모달 ── */}
      {showExitModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl px-8 py-7 flex flex-col items-center gap-5 min-w-[320px]">
            <div className="text-2xl">⚠️</div>
            <div className="text-center">
              <p className="font-bold text-gray-800 text-base mb-1">정말 종료하시겠습니까?</p>
              <p className="text-sm text-gray-500">저장되지 않은 데이터는 손실될 수 있습니다.</p>
              {converting && (
                <p className="text-xs text-red-500 mt-1 font-medium">⚠️ 변환이 진행 중입니다. 종료 시 변환이 중단됩니다.</p>
              )}
            </div>
            <div className="flex gap-3 mt-1">
              <button
                onClick={() => {
                  setShowExitModal(false);
                  electronAPI?.cancelClose?.();
                }}
                className="px-5 py-2 rounded-lg border border-gray-300 text-gray-700 bg-gray-50 hover:bg-gray-100 font-medium text-sm"
              >
                취소
              </button>
              <button
                onClick={() => {
                  // 종료 시 작업 내용 초기화 (설정은 유지)
                  localStorage.removeItem("gb_autosave_raw");
                  localStorage.removeItem("gb_convert_progress");
                  clearAudioFromDB().catch(() => {});
                  if (converting) {
                    localStorage.removeItem("gb_convert_progress");
                  }
                  electronAPI?.confirmClose?.();
                }}
                className="px-5 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium text-sm"
              >
                종료
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
