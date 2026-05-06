import { create } from "zustand";
import type { ViewKind } from "../api/types";

interface ViewStore {
  view: ViewKind;
  selectedNodeId: string | null;
  search: string;
  setView: (next: ViewKind) => void;
  setSelectedNode: (id: string | null) => void;
  setSearch: (q: string) => void;
}

function readFromUrl(): { view: ViewKind; selectedNodeId: string | null } {
  if (typeof window === "undefined") return { view: "precommit", selectedNodeId: null };
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get("view");
  const view: ViewKind = rawView === "impact" ? "impact" : "precommit";
  const selectedNodeId = params.get("node");
  return { view, selectedNodeId };
}

function writeToUrl(state: { view: ViewKind; selectedNodeId: string | null }): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("view", state.view);
  if (state.selectedNodeId) url.searchParams.set("node", state.selectedNodeId);
  else url.searchParams.delete("node");
  window.history.replaceState(null, "", url.toString());
}

export const useView = create<ViewStore>((set, get) => ({
  view: "precommit",
  selectedNodeId: null,
  search: "",
  setView: (next) => {
    set({ view: next });
    writeToUrl({ view: next, selectedNodeId: get().selectedNodeId });
  },
  setSelectedNode: (id) => {
    set({ selectedNodeId: id });
    writeToUrl({ view: get().view, selectedNodeId: id });
  },
  setSearch: (q) => set({ search: q }),
}));

/** Initialize from the URL on app boot. */
export function initView(): void {
  const { view, selectedNodeId } = readFromUrl();
  useView.setState({ view, selectedNodeId });
}
