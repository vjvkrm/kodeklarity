import { create } from "zustand";

type Theme = "light" | "dark";
const STORAGE_KEY = "kk-dashboard-theme";

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage may be unavailable (private mode etc.)
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

interface ThemeStore {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
}

export const useTheme = create<ThemeStore>((set, get) => ({
  theme: "light",
  setTheme: (next) => {
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    set({ theme: next });
  },
  toggle: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
}));

/** Initialize theme on app boot. Call once from main.tsx. */
export function initTheme(): void {
  const initial = getInitialTheme();
  applyTheme(initial);
  useTheme.setState({ theme: initial });
}
