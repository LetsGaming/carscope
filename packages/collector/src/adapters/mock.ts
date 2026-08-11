import {
  CURRENCY, MARKET, MINUTE_MS, ok, psToWatt,
  type Criteria, type ListPage, type RawListing, type RequestSpec,
  type Result, type SourceAdapter,
} from "@carscope/core";
import type { Transport } from "../http.ts";

const CATALOGUE: readonly Omit<RawListing, "sourceListingId">[] = [
  {
    url: "https://mock.local/1", title: "Nissan Skyline R34 GT-T Sedan", price: 34_900,
    currency: CURRENCY.eur, photoUrls: ["https://mock.local/1/a.jpg"],
    attributes: {
      make: "Nissan", model: "Skyline", variant: "GT-T", bodyStyle: "sedan",
      firstRegistration: "1999-06", mileageKm: 96_400, powerW: psToWatt(206), fuel: "petrol",
      gearbox: "manual", sellerType: "dealer", sellerName: "JDM Import Venlo",
      city: "Venlo", postalCode: "5911", damaged: false,
    },
  },
  {
    url: "https://mock.local/2", title: "Nissan Skyline R34 GT-T Coupe", price: 35_500,
    currency: CURRENCY.eur, photoUrls: ["https://mock.local/2/a.jpg"],
    attributes: {
      make: "Nissan", model: "Skyline", variant: "GT-T", bodyStyle: "coupe",
      firstRegistration: "1998-11", mileageKm: 142_900, powerW: psToWatt(184), fuel: "petrol",
      gearbox: "automatic", sellerType: "private", sellerName: null,
      city: "Malmoe", postalCode: "21120", damaged: false,
    },
  },
  {
    url: "https://mock.local/3", title: "Nissan Skyline R34 GT-T unrestauriert", price: 36_900,
    currency: CURRENCY.eur, photoUrls: [],
    attributes: {
      make: "Nissan", model: "Skyline", variant: "GT-T", bodyStyle: "sedan",
      firstRegistration: "2000-03", mileageKm: 118_200, powerW: psToWatt(151), fuel: "petrol",
      gearbox: "manual", sellerType: "private", sellerName: null,
      city: "Hamburg", postalCode: "22765", damaged: false,
    },
  },
];

/** Deterministic source so dev, CI and offline runs never touch a real portal. */
export const MOCK_HOST = "mock.local";

/** Serves mock.local in process, so dev, CI and offline runs need no egress. */
const PIXEL_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

export function withLoopback(next: Transport): Transport {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.host !== MOCK_HOST) return next(url, init);
    if (/\.(jpg|jpeg|png|webp)$/i.test(parsed.pathname)) {
      return new Response(PIXEL_PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(parsed.search.slice(1), { status: 200 });
  };
}

export const mock: SourceAdapter = {
  id: "mock",
  label: "Mock",
  markets: [MARKET.de],
  currency: CURRENCY.eur,
  minIntervalMs: MINUTE_MS,
  unsupported: [],

  buildQuery(_c: Criteria, page: number): RequestSpec {
    return { url: `https://mock.local/search?page=${page}` };
  },

  parseList(body: string): Result<ListPage> {
    const page = Number.parseInt(new URLSearchParams(body).get("page") ?? "1", 10);
    if (page > 1) return ok({ listings: [], hasMore: false });
    return ok({
      listings: CATALOGUE.map((l, i) => ({ ...l, sourceListingId: `mock-${i + 1}` })),
      hasMore: false,
    });
  },
};
