interface ShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS: Array<[string, string]> = [
  ["R", "Refresh active view (rebuild graph + re-query)"],
  ["1", "Switch to Precommit"],
  ["2", "Switch to Impact"],
  ["/", "Focus search"],
  ["Esc", "Clear selection / blur search"],
  ["?", "Show this help"],
];

export default function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-md"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl surface w-[440px]"
        style={{
          border: "1px solid var(--border-strong)",
          boxShadow:
            "0 24px 60px -16px rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.04) inset",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-3.5"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <h2 className="text-[14px] font-semibold tracking-tight text-default">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:text-default hover:surface-subtle transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <ul className="p-2">
          {SHORTCUTS.map(([key, desc]) => (
            <li
              key={key}
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:surface-subtle transition-colors"
            >
              <kbd
                className="font-mono text-[11px] px-2 py-1 rounded-md min-w-[2.25rem] text-center font-medium"
                style={{
                  background: "var(--bg-subtle)",
                  color: "var(--text)",
                  border: "1px solid var(--border-strong)",
                  boxShadow: "0 1px 0 var(--border-strong)",
                }}
              >
                {key}
              </kbd>
              <span className="text-[13px] text-muted">{desc}</span>
            </li>
          ))}
        </ul>

        <div
          className="px-5 py-3"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <div className="text-[11px] uppercase tracking-wide text-muted mb-2">
            Node indicators
          </div>
          <ul className="space-y-1.5">
            <li className="flex items-center gap-2 text-[13px] text-muted">
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  display: "inline-block",
                }}
              />
              Memory attached to this node
            </li>
            <li className="flex items-center gap-2 text-[13px] text-muted">
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "#f59e0b",
                  display: "inline-block",
                }}
              />
              Stale memory — anchor symbol no longer in the graph
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
