import { useData } from "../state/data";
import { useTheme } from "../state/theme";
import { useView } from "../state/view";

export default function TopBar() {
  const view = useView((s) => s.view);
  const search = useView((s) => s.search);
  const setSearch = useView((s) => s.setSearch);
  const refresh = useData((s) => s.refresh);
  const buildLoading = useData((s) => s.loading.build);
  const queryLoading = useData((s) => s.loading[view]);
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);

  const refreshing = buildLoading || queryLoading;
  const refreshLabel = view === "precommit" ? "Refresh Precommit" : "Refresh Impact";

  return (
    <header
      className="flex items-center gap-3 px-4 h-11 shrink-0 surface-subtle"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2">
        <Logo />
        <div className="font-semibold tracking-tight text-[13px] text-default">
          KodeKlarity
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-4">
        <div className="relative w-full max-w-md">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none">
            <SearchIcon />
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search nodes…"
            className="w-full h-8 rounded-md pl-8 pr-10 text-[13px] placeholder:text-subtle focus:outline-none transition-colors"
            style={{
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--accent)";
              e.currentTarget.style.boxShadow = "0 0 0 1px var(--accent)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.boxShadow = "none";
            }}
            data-search-input
          />
          <kbd
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] px-1 py-px rounded font-mono pointer-events-none"
            style={{
              background: "var(--bg-subtle)",
              color: "var(--text-subtle)",
              border: "1px solid var(--border)",
            }}
          >
            /
          </kbd>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void refresh(view)}
        disabled={refreshing}
        className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] font-medium transition-colors disabled:opacity-60 disabled:cursor-progress"
        style={{
          background: "var(--accent)",
          color: "var(--accent-text)",
        }}
        onMouseEnter={(e) => {
          if (!refreshing) e.currentTarget.style.background = "var(--accent-hover)";
        }}
        onMouseLeave={(e) => {
          if (!refreshing) e.currentTarget.style.background = "var(--accent)";
        }}
      >
        {refreshing ? (
          <>
            <Spinner /> {buildLoading ? "Building" : "Querying"}
          </>
        ) : (
          <>
            <RefreshIcon />
            {refreshLabel}
          </>
        )}
      </button>

      <button
        type="button"
        onClick={toggleTheme}
        title="Toggle theme"
        aria-label="Toggle theme"
        className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted hover:text-default transition-colors"
        style={{ background: "transparent" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
    </header>
  );
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function Logo() {
  return (
    <span
      className="inline-flex items-center justify-center h-6 w-6 rounded-md text-[11px] font-bold"
      style={{ background: "var(--accent)", color: "var(--accent-text)" }}
    >
      kk
    </span>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3 h-3 rounded-full animate-spin"
      style={{
        border: "2px solid rgba(255,255,255,0.35)",
        borderTopColor: "currentColor",
      }}
      aria-hidden
    />
  );
}

function RefreshIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
