import { useData } from "../state/data";

export default function Onboarding() {
  const status = useData((s) => s.status);
  const build = useData((s) => s.build);
  const buildLoading = useData((s) => s.loading.build);
  const error = useData((s) => s.error);
  const cwd = status?.cwd ?? "";

  return (
    <div className="flex-1 flex items-center justify-center p-8 surface-canvas">
      <div
        className="max-w-lg w-full rounded-2xl surface p-8"
        style={{
          border: "1px solid var(--border)",
          boxShadow:
            "0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 40px -12px rgba(0,0,0,0.18)",
        }}
      >
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center mb-5"
          style={{ background: "var(--accent-bg-soft)", color: "var(--accent)" }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <circle cx="5" cy="6" r="2" />
            <circle cx="19" cy="6" r="2" />
            <circle cx="5" cy="18" r="2" />
            <circle cx="19" cy="18" r="2" />
            <path d="M7 6.5l3 4M17 6.5l-3 4M7 17.5l3-4M17 17.5l-3-4" />
          </svg>
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight mb-1.5 text-default">
          No graph found yet
        </h1>
        <p className="text-[13px] text-muted mb-6 leading-relaxed">
          KodeKlarity needs to scan your repo and build the code graph before the
          dashboard can show precommit and impact views.
        </p>

        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-subtle mb-1.5">Repo</div>
        <div
          className="font-mono text-[12px] surface-subtle rounded-lg px-3 py-2 mb-6 break-all"
          style={{ border: "1px solid var(--border)" }}
        >
          {cwd || "(unknown)"}
        </div>

        <button
          type="button"
          onClick={() => void build()}
          disabled={buildLoading}
          className="inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-60 disabled:cursor-progress"
          style={{ background: "var(--accent)", color: "var(--accent-text)" }}
          onMouseEnter={(e) => {
            if (!buildLoading) e.currentTarget.style.background = "var(--accent-hover)";
          }}
          onMouseLeave={(e) => {
            if (!buildLoading) e.currentTarget.style.background = "var(--accent)";
          }}
        >
          {buildLoading ? "Building graph…" : "Build graph now"}
        </button>

        {error && (
          <div
            className="mt-4 rounded-lg p-3 text-[12px] whitespace-pre-wrap"
            style={{
              background: "var(--danger-bg)",
              color: "var(--danger)",
              border: "1px solid var(--danger)",
              borderColor: "color-mix(in srgb, var(--danger) 30%, transparent)",
            }}
          >
            {error}
          </div>
        )}

        <div className="mt-6 text-[11px] text-subtle">
          Equivalent to running{" "}
          <code
            className="font-mono px-1.5 py-0.5 rounded text-[11px]"
            style={{ background: "var(--bg-subtle)", color: "var(--text-muted)" }}
          >
            kk init --force
          </code>{" "}
          from this directory.
        </div>
      </div>
    </div>
  );
}
