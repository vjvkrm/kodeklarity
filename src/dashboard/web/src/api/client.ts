import type {
  BuildResult,
  ImpactResponse,
  NodeDetails,
  PrecommitResponse,
  StatusResponse,
} from "./types";

async function getJson<T>(pathname: string): Promise<T> {
  const res = await fetch(pathname, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${pathname} → ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(pathname: string): Promise<T> {
  const res = await fetch(pathname, { method: "POST", headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${pathname} → ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => getJson<StatusResponse>("/api/status"),
  build: () => postJson<BuildResult>("/api/build"),
  precommit: () => getJson<PrecommitResponse>("/api/precommit"),
  impact: () => getJson<ImpactResponse>("/api/impact"),
  node: (id: string) => getJson<NodeDetails>(`/api/node/${encodeURIComponent(id)}`),
};
