import type {
  CollectionJob, EditableCriteria, MarketReport, Result, SavedSearch, Source,
} from "./types";
import { readStoredApiKey } from "./useApiKey";

export class ApiError extends Error {
  readonly status: number;
  /** True on 401/403, so a caller can prompt for a key rather than show a generic error. */
  readonly unauthorized: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.unauthorized = status === 401 || status === 403;
  }
}

/**
 * The one place a response is trusted to match its declared type. Every route
 * serialises through a compiled response schema, so the shape is enforced on the
 * server; keeping the assertion here means no component or composable repeats it.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const apiKey = readStoredApiKey();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
      ...init?.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : res.statusText;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

/** Criteria travel flat on the query string, so a search is a plain GET. */
export function queryString(
  c: EditableCriteria,
  extra: Record<string, string | number | boolean>,
): string {
  const q = new URLSearchParams();
  const put = (key: string, value: string | number | boolean | null): void => {
    if (value !== null && value !== "" && value !== false) q.set(key, String(value));
  };
  put("text", [c.make, c.model, c.text].filter(Boolean).join(" ").trim());
  put("priceMin", c.priceEur.min); put("priceMax", c.priceEur.max);
  put("kmMin", c.mileageKm.min); put("kmMax", c.mileageKm.max);
  put("yearMin", c.registrationYear.min); put("yearMax", c.registrationYear.max);
  put("psMin", c.powerPs.min); put("psMax", c.powerPs.max);
  put("fuel", c.fuel); put("gearbox", c.gearbox);
  put("sellerType", c.sellerType); put("bodyStyle", c.bodyStyle);
  put("markets", c.markets.join(",")); put("postalCode", c.postalCode);
  put("radiusKm", c.radiusKm); put("excludeDamaged", c.excludeDamaged);
  for (const [key, value] of Object.entries(extra)) put(key, value);
  return q.toString();
}

export const api = {
  listSearches: (): Promise<SavedSearch[]> => request("/searches"),
  createSearch: (name: string, criteria: EditableCriteria): Promise<SavedSearch> =>
    request("/searches", { method: "POST", body: JSON.stringify({ name, criteria }) }),
  updateSearch: (id: string, name: string, criteria: EditableCriteria): Promise<SavedSearch> =>
    request(`/searches/${id}`, { method: "PUT", body: JSON.stringify({ name, criteria }) }),
  deleteSearch: (id: string): Promise<void> => request(`/searches/${id}`, { method: "DELETE" }),
  // The server's default is active-only, and queryString leaves out a boolean
  // false, so the flag travels as text.
  results: (criteria: EditableCriteria, active: boolean): Promise<Result[]> =>
    request(`/vehicles?${queryString(criteria, { active: String(active) })}`),
  hideVehicle: (id: string): Promise<void> => request(`/vehicles/${id}`, { method: "DELETE" }),
  restoreVehicle: (id: string): Promise<void> =>
    request(`/vehicles/${id}/restore`, { method: "POST" }),
  market: (criteria: EditableCriteria, months: number): Promise<MarketReport> =>
    request(`/market?${queryString(criteria, { months })}`),
  sources: (): Promise<Source[]> => request("/sources"),
  setSource: (id: string, enabled: boolean): Promise<Source[]> =>
    request(`/sources/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  collect: (criteria: EditableCriteria, force: boolean): Promise<CollectionJob> =>
    request(`/collect?${queryString(criteria, { force })}`, { method: "POST" }),
  job: (): Promise<CollectionJob | null> => request("/collect"),
  jobStream: (): EventSource | null =>
    typeof EventSource === "undefined" ? null : new EventSource("/api/events"),
};

export interface VehicleDetail {
  id: string; make: string; model: string; variant: string | null;
  bodyStyle: string | null; firstRegistration: string | null;
  mileageKm: number | null; powerW: number | null;
  fuel: string | null; gearbox: string | null;
  sellerType: string | null; sellerName: string | null;
  market: string; city: string | null; postalCode: string | null;
  description: string | null;
  daysListed: number; firstListedAt: string | null; priceChangeCount: number;
  currentPrice: PriceSnapshot; firstPrice: PriceSnapshot;
  photos: { url: string; localPath: string | null; position: number }[];
  listings: { sourceId: string; url: string; title: string; firstSeenAt: string; delistedAt: string | null }[];
}

export interface PriceSnapshot {
  observedAt: string; baseAmount: number; amount: number; currency: string; sourceId: string;
}

export const vehicleApi = {
  detail: (id: string): Promise<VehicleDetail> => request(`/vehicles/${id}`),
  prices: (id: string): Promise<PriceSnapshot[]> => request(`/vehicles/${id}/prices`),
};
