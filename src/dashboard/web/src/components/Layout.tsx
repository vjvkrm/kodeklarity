import { useEffect, useState } from "react";
import { useData } from "../state/data";
import { useView } from "../state/view";
import NavTabs from "./NavTabs";
import TopBar from "./TopBar";
import Graph from "./graph/Graph";
import RightPane from "./RightPane";
import { CleanTreeEmpty, UntrackedFilesCallout } from "./EmptyStates";
import Onboarding from "./Onboarding";
import ShortcutsOverlay from "./ShortcutsOverlay";

export default function Layout() {
  const status = useData((s) => s.status);
  const fetchStatus = useData((s) => s.fetchStatus);
  const fetchPrecommit = useData((s) => s.fetchPrecommit);
  const fetchImpact = useData((s) => s.fetchImpact);
  const refresh = useData((s) => s.refresh);
  const view = useView((s) => s.view);
  const setView = useView((s) => s.setView);
  const search = useView((s) => s.search);
  const setSearch = useView((s) => s.setSearch);
  const setSelectedNode = useView((s) => s.setSelectedNode);
  const data = useData((s) => s.getGraphFor(view));
  const loading = useData((s) => s.loading[view]);
  const buildLoading = useData((s) => s.loading.build);
  const error = useData((s) => s.error);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Boot: load status. If a graph exists, pre-fetch the active view.
  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!status?.graphExists) return;
    if (view === "precommit") void fetchPrecommit();
    else void fetchImpact();
  }, [status?.graphExists, view, fetchPrecommit, fetchImpact]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

      if (e.key === "/" && !inField) {
        e.preventDefault();
        const el = document.querySelector<HTMLInputElement>("[data-search-input]");
        el?.focus();
        return;
      }
      if (e.key === "Escape") {
        if (showShortcuts) {
          setShowShortcuts(false);
          return;
        }
        if (inField) (target as HTMLInputElement).blur();
        else {
          setSelectedNode(null);
          if (search) setSearch("");
        }
        return;
      }
      if (inField) return;

      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        void refresh(view);
      } else if (e.key === "1") {
        e.preventDefault();
        setView("precommit");
      } else if (e.key === "2") {
        e.preventDefault();
        setView("impact");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search, setSearch, setSelectedNode, refresh, view, setView, showShortcuts]);

  if (status && !status.graphExists) {
    return (
      <div className="h-screen flex flex-col">
        <TopBar />
        <Onboarding />
      </div>
    );
  }

  const refreshing = buildLoading || loading;

  return (
    <div className="h-screen flex flex-col">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        <NavTabs />
        <main className="flex-1 flex flex-col overflow-hidden relative">
          {error && (
            <div
              className="m-4 p-3 rounded-lg text-[12px]"
              style={{
                background: "var(--danger-bg)",
                color: "var(--danger)",
                border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
              }}
            >
              {error}
            </div>
          )}
          {data && data.changedFiles.length > 0 && (
            <UntrackedFilesCallout files={data.changedFiles} coverageAction={data.coverageAction} />
          )}
          <div
            className={
              "flex-1 flex flex-col transition-opacity duration-150 " +
              (refreshing && data ? "opacity-50" : "opacity-100")
            }
          >
            {data && data.nodes.length === 0 && !loading ? (
              <CleanTreeEmpty view={view} />
            ) : (
              <Graph view={view} nodes={data?.nodes ?? []} edges={data?.edges ?? []} />
            )}
          </div>
          {refreshing && (
            <div
              className="absolute top-3 right-3 px-3 py-1.5 rounded-md text-[12px] font-medium flex items-center gap-2"
              style={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-strong)",
                boxShadow: "0 4px 12px -2px rgba(0,0,0,0.18)",
              }}
            >
              <span
                className="inline-block w-3 h-3 rounded-full animate-spin"
                style={{
                  border: "2px solid var(--border-strong)",
                  borderTopColor: "var(--accent)",
                }}
              />
              <span className="text-muted">{buildLoading ? "Rebuilding graph…" : "Querying…"}</span>
            </div>
          )}
        </main>
        <RightPane />
      </div>
      <ShortcutsOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </div>
  );
}
