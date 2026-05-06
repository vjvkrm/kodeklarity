import { useCallback, useEffect, useRef, useState } from "react";
import { useView } from "../state/view";
import { api } from "../api/client";
import type { NodeDetails } from "../api/types";

const WIDTH_STORAGE_KEY = "kk-dashboard-rightpane-width";
const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 480;

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH;
}

export default function RightPane() {
  const selectedNodeId = useView((s) => s.selectedNodeId);
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState<number>(() => readStoredWidth());
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!selectedNodeId) {
      setDetails(null);
      return;
    }
    if (selectedNodeId.startsWith("__new__:")) {
      setDetails(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .node(selectedNodeId)
      .then((d) => {
        if (!cancelled) setDetails(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedNodeId]);

  const onMouseMove = useCallback((e: MouseEvent) => {
    const ds = dragStateRef.current;
    if (!ds) return;
    const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, ds.startWidth - (e.clientX - ds.startX)));
    setWidth(next);
  }, []);

  const onMouseUp = useCallback(() => {
    dragStateRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      // ignore
    }
  }, [onMouseMove, width]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return (
    <aside
      className="relative flex flex-col shrink-0 surface overflow-hidden"
      style={{ width, borderLeft: "1px solid var(--border)" }}
    >
      <div
        onMouseDown={onMouseDown}
        title="Drag to resize"
        className="absolute top-0 left-0 w-1 h-full cursor-col-resize z-10 transition-colors"
        style={{ background: "transparent" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--border-strong)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
        aria-hidden
      />
      {!selectedNodeId ? (
        <EmptySelection />
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-5 pt-4 pb-3 shrink-0">
            {loading && <div className="text-[13px] text-muted">Loading…</div>}
            {error && (
              <div
                className="text-[12px] rounded-lg px-3 py-2"
                style={{ background: "var(--danger-bg)", color: "var(--danger)" }}
              >
                {error}
              </div>
            )}
            {!loading && !error && !details && selectedNodeId.startsWith("__new__:") && (
              <NewSymbolPanel id={selectedNodeId} />
            )}
            {details && <NodeHeader details={details} />}
          </div>
          {details && (
            <div className="flex-1 overflow-hidden flex flex-col px-5 pb-5 gap-4">
              {details.diff ? (
                <DiffBlock diff={details.diff} />
              ) : (
                <div
                  className="text-[12px] italic rounded-lg px-3 py-2 text-muted"
                  style={{
                    background: "var(--bg-subtle)",
                    border: "1px dashed var(--border-strong)",
                  }}
                >
                  Not changed in this diff.
                </div>
              )}
              {details.source && (
                <details className="group shrink-0">
                  <summary
                    className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.12em] mb-1.5 select-none text-subtle hover:text-default"
                  >
                    Source snippet
                  </summary>
                  <pre
                    className="text-[11px] font-mono whitespace-pre p-3 mt-1 rounded-lg max-h-60 overflow-auto leading-relaxed"
                    style={{
                      background: "var(--bg-canvas)",
                      border: "1px solid var(--border)",
                      color: "var(--text-muted)",
                    }}
                  >
                    {details.source}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function EmptySelection() {
  return (
    <div className="p-8 flex flex-col items-center justify-center h-full text-center">
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
        style={{ background: "var(--bg-subtle)", color: "var(--text-subtle)" }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </div>
      <div className="text-[13px] font-medium text-default">Inspector</div>
      <div className="text-[12px] text-muted mt-0.5">Select a node to view diff and metadata.</div>
    </div>
  );
}

function NewSymbolPanel({ id }: { id: string }) {
  const [, file, symbol] = id.split(":");
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-subtle mb-1">New symbol</div>
      <div className="font-mono text-[13px] break-all mb-1.5 text-default">{symbol}</div>
      <FilePathBadge path={file} />
      <p className="mt-4 text-[12px] text-muted leading-relaxed">
        This symbol is in your diff but not yet in the graph DB. Run a refresh to rebuild.
      </p>
    </div>
  );
}

function NodeHeader({ details }: { details: NodeDetails }) {
  const status = details.changed ? "changed" : "neighbor";
  const statusColor = details.changed ? "var(--accent)" : "var(--text-muted)";
  const statusBg = details.changed ? "var(--accent-bg-soft)" : "var(--bg-subtle)";

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <KindPill kind={details.kind} />
        <span
          className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.1em] px-1.5 py-0.5 rounded"
          style={{ background: statusBg, color: statusColor }}
        >
          {details.changed && (
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: statusColor }}
              aria-hidden
            />
          )}
          {status}
        </span>
      </div>
      <div className="font-mono text-[15px] font-medium break-all text-default leading-tight">
        {details.symbol}
      </div>
      <div className="mt-2">
        <FilePathBadge path={`${details.file}:${details.line}`} />
      </div>
    </div>
  );
}

function KindPill({ kind }: { kind: string }) {
  return (
    <span
      className="inline-flex items-center text-[10px] font-medium uppercase tracking-[0.1em] px-1.5 py-0.5 rounded"
      style={{
        background: "var(--bg-subtle)",
        color: "var(--text-muted)",
        border: "1px solid var(--border)",
      }}
    >
      {kind}
    </span>
  );
}

function FilePathBadge({ path }: { path: string }) {
  return (
    <span
      className="inline-block font-mono text-[11px] px-2 py-0.5 rounded text-muted break-all"
      style={{ background: "var(--bg-subtle)" }}
    >
      {path}
    </span>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <div
      className="flex-1 overflow-hidden rounded-lg flex flex-col"
      style={{ background: "var(--bg-canvas)", border: "1px solid var(--border)" }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-subtle shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <span>Diff</span>
        <span className="font-mono normal-case tracking-normal text-[10px] text-subtle">
          {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
      </div>
      <pre className="flex-1 text-[11.5px] font-mono whitespace-pre overflow-auto m-0 leading-[1.55]">
        {lines.map((line, i) => {
          const cls = classifyDiffLine(line);
          return (
            <div key={i} className={`px-3 ${cls}`}>
              {line || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function classifyDiffLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff "))
    return "text-subtle";
  if (line.startsWith("@@"))
    return "diff-hunk";
  if (line.startsWith("+"))
    return "diff-add";
  if (line.startsWith("-"))
    return "diff-del";
  return "text-muted";
}
