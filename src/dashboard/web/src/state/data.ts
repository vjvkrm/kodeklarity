import { create } from "zustand";
import type { ImpactResponse, PrecommitResponse, StatusResponse } from "../api/types";
import { api } from "../api/client";

type GraphData = PrecommitResponse | ImpactResponse;

interface DataStore {
  status: StatusResponse | null;
  precommit: PrecommitResponse | null;
  impact: ImpactResponse | null;
  loading: { status: boolean; build: boolean; precommit: boolean; impact: boolean };
  error: string | null;

  fetchStatus: () => Promise<void>;
  build: () => Promise<void>;
  fetchPrecommit: () => Promise<void>;
  fetchImpact: () => Promise<void>;
  refresh: (kind: "precommit" | "impact") => Promise<void>;
  clearError: () => void;
  getGraphFor: (kind: "precommit" | "impact") => GraphData | null;
}

function setLoading(set: (fn: (s: DataStore) => Partial<DataStore>) => void, key: keyof DataStore["loading"], v: boolean) {
  set((s) => ({ loading: { ...s.loading, [key]: v } }));
}

export const useData = create<DataStore>((set, get) => ({
  status: null,
  precommit: null,
  impact: null,
  loading: { status: false, build: false, precommit: false, impact: false },
  error: null,

  fetchStatus: async () => {
    setLoading(set, "status", true);
    try {
      const status = await api.status();
      set({ status, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(set, "status", false);
    }
  },

  build: async () => {
    setLoading(set, "build", true);
    try {
      const result = await api.build();
      if (result.status !== "ok") {
        set({ error: `Build failed (exit ${result.exitCode}): ${result.stderr || result.stdout}` });
      } else {
        set({ error: null });
      }
      // Always re-read status after a build attempt.
      await get().fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(set, "build", false);
    }
  },

  fetchPrecommit: async () => {
    setLoading(set, "precommit", true);
    try {
      const data = await api.precommit();
      set({ precommit: data, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(set, "precommit", false);
    }
  },

  fetchImpact: async () => {
    setLoading(set, "impact", true);
    try {
      const data = await api.impact();
      set({ impact: data, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(set, "impact", false);
    }
  },

  refresh: async (kind) => {
    // v1: full rebuild + re-query active view (per design discussion).
    await get().build();
    if (kind === "precommit") await get().fetchPrecommit();
    else await get().fetchImpact();
  },

  clearError: () => set({ error: null }),

  getGraphFor: (kind) => (kind === "precommit" ? get().precommit : get().impact),
}));
