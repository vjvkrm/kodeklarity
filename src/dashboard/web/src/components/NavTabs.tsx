import { useView } from "../state/view";
import type { ViewKind } from "../api/types";

const TABS: Array<{ id: ViewKind; label: string; hint: string; key: string }> = [
  { id: "precommit", label: "Precommit", hint: "Closed set — what you changed", key: "1" },
  { id: "impact", label: "Impact", hint: "Changed + 1-hop ring", key: "2" },
];

export default function NavTabs() {
  const view = useView((s) => s.view);
  const setView = useView((s) => s.setView);
  return (
    <nav
      className="flex flex-col w-[180px] shrink-0 surface-subtle"
      style={{ borderRight: "1px solid var(--border)" }}
    >
      <div className="px-3 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-subtle">
        Views
      </div>
      <div className="flex flex-col">
        {TABS.map((tab) => {
          const active = view === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setView(tab.id)}
              className="group relative w-full text-left pl-4 pr-3 py-2.5 text-[13px] transition-colors"
              style={{
                background: active ? "var(--bg-elevated)" : "transparent",
                color: active ? "var(--text)" : "var(--text-muted)",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = "var(--bg)";
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = "transparent";
              }}
            >
              {/* Left-border accent — VS Code editor-tab cue */}
              <span
                aria-hidden
                className="absolute left-0 top-0 bottom-0 w-0.5 transition-colors"
                style={{ background: active ? "var(--accent)" : "transparent" }}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{tab.label}</span>
                <kbd
                  className="text-[9px] px-1 py-px rounded font-mono"
                  style={{
                    background: "var(--bg)",
                    color: "var(--text-subtle)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {tab.key}
                </kbd>
              </div>
              <div className="text-[11px] mt-0.5 leading-snug text-subtle">{tab.hint}</div>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
