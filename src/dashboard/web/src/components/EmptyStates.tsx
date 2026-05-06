import type { ChangedFile, CoverageAction, ViewKind } from "../api/types";

interface CleanTreeProps {
  view: ViewKind;
}

export function CleanTreeEmpty({ view }: CleanTreeProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 text-center surface-canvas">
      <div className="max-w-md">
        <div
          className="w-12 h-12 mx-auto rounded-xl flex items-center justify-center mb-4"
          style={{ background: "var(--bg-subtle)", color: "var(--text-subtle)" }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>
        <h2 className="text-[15px] font-semibold mb-1 text-default">No uncommitted changes</h2>
        <p className="text-[13px] text-muted leading-relaxed">
          {view === "precommit"
            ? "There's nothing to show in precommit view — your working tree is clean."
            : "Impact view tracks uncommitted changes. Make an edit and refresh to see it expand."}
        </p>
      </div>
    </div>
  );
}

interface UntrackedFilesProps {
  files: ChangedFile[];
  coverageAction: CoverageAction | null;
}

function buildAgentPrompt(files: string[], action: CoverageAction | null): string {
  const lines = [
    "KodeKlarity has no boundary nodes for these files in the current diff:",
    ...files.map((f) => `  - ${f}`),
    "",
    "Decide for each file:",
    "  (a) It's a real boundary that should be tracked — add a customBoundary in .kodeklarity/config.json.",
    "  (b) It's intentionally not a boundary (entry/bootstrap, pure type file, dispatch table) — add the path to ignoreCoverage.",
    "",
    "After editing config:",
    "  1) Run: kk init --force",
    "  2) Verify with: kk status",
    "  3) Re-run the dashboard refresh.",
  ];
  if (action) {
    lines.push(
      "",
      "Suggested customBoundary entry to start from (edit name/kind/glob/symbolPattern as needed):",
      "  " + JSON.stringify(action.example_boundary, null, 2).split("\n").join("\n  "),
    );
  }
  lines.push(
    "",
    "Schema:",
    "  customBoundaries: { name, kind, glob, symbolPattern, reason }[]",
    "  ignoreCoverage: string[]   // glob patterns",
  );
  return lines.join("\n");
}

export function UntrackedFilesCallout({ files, coverageAction }: UntrackedFilesProps) {
  const untracked = files.filter((f) => f.relevant && !f.tracked && !f.ignored);
  if (untracked.length === 0) return null;

  const copy = async () => {
    const prompt = buildAgentPrompt(untracked.map((f) => f.file), coverageAction);
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      // ignore — older browsers, no permission, etc.
    }
  };

  return (
    <div
      className="m-4 rounded-xl p-4"
      style={{
        background: "var(--warn-bg)",
        border: "1px solid color-mix(in srgb, var(--warn) 30%, transparent)",
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5"
          style={{
            background: "color-mix(in srgb, var(--warn) 20%, transparent)",
            color: "var(--warn)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-default">
            {untracked.length} file{untracked.length === 1 ? "" : "s"} need a decision
          </div>
          <p className="text-[12px] text-muted mt-0.5 leading-relaxed">
            Either add a <Code>customBoundary</Code> for them, or add their path to{" "}
            <Code>ignoreCoverage</Code> if they aren't real boundaries.
          </p>
          <ul className="mt-2 space-y-0.5 text-[11.5px] font-mono text-muted">
            {untracked.slice(0, 8).map((f) => (
              <li key={f.file} className="truncate">· {f.file}</li>
            ))}
            {untracked.length > 8 && (
              <li className="italic text-subtle">+ {untracked.length - 8} more</li>
            )}
          </ul>
          <button
            type="button"
            onClick={() => void copy()}
            className="mt-3 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium transition-colors"
            style={{
              background: "color-mix(in srgb, var(--warn) 18%, transparent)",
              color: "var(--warn)",
              border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "color-mix(in srgb, var(--warn) 28%, transparent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "color-mix(in srgb, var(--warn) 18%, transparent)";
            }}
          >
            <CopyIcon /> Copy AI agent prompt
          </button>
        </div>
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="font-mono px-1 py-px rounded text-[11px]"
      style={{ background: "var(--bg-subtle)", color: "var(--text)" }}
    >
      {children}
    </code>
  );
}

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
