import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CRITERIA, marketsFor, type Criteria, type RawListing } from "@carscope/core";
import { mobileDe } from "../../packages/collector/src/adapters/mobilede.ts";
import { kleinanzeigen } from "../../packages/collector/src/adapters/kleinanzeigen.ts";
import { autoScout24 } from "../../packages/collector/src/adapters/autoscout24.ts";
import { mobileDeMakeId } from "../../packages/collector/src/adapters/mobilede-makes.ts";
import { splitMakeModel } from "../../packages/collector/src/adapters/make-model.ts";
import { applyUnsupported } from "../../packages/collector/src/filter.ts";

/** Every query is built for one country; the source covers several. */
const DE = { market: "DE", hints: {} } as const;

/** The query a real search produced on each portal. */
const R34: Criteria = {
  ...EMPTY_CRITERIA,
  text: "Nissan Skyline R34",
  priceEur: { min: 5_000, max: 100_000 },
  mileageKm: { min: 5_000, max: 200_000 },
  registrationYear: { min: 1998, max: 2002 },
  powerPs: { min: 280, max: null },
};

const split = (text: string): { make: string | null; model: string | null } => {
  const { make, model } = splitMakeModel({ ...EMPTY_CRITERIA, text });
  return { make, model };
};

test("free text splits into a make and a model across manufacturers", () => {
  assert.deepEqual(split("Nissan Skyline R34"), { make: "Nissan", model: "Skyline" });
  assert.deepEqual(split("Honda Jazz"), { make: "Honda", model: "Jazz" });
  assert.deepEqual(split("BMW 3er Touring"), { make: "BMW", model: "3er" });
  assert.deepEqual(split("Škoda Octavia RS"), { make: "Škoda", model: "Octavia" });
});

test("makes of several words are matched whole, longest first", () => {
  // "Rover" alone is a make too, so the longer match has to win.
  assert.deepEqual(split("Land Rover Range Rover Sport"), { make: "Land Rover", model: "Range" });
  assert.deepEqual(split("Alfa Romeo Giulia"), { make: "Alfa Romeo", model: "Giulia" });
  assert.deepEqual(split("Aston Martin DB9"), { make: "Aston Martin", model: "DB9" });
  assert.deepEqual(split("Rolls-Royce Ghost"), { make: "Rolls-Royce", model: "Ghost" });
});

test("common short names resolve to what the portals call them", () => {
  assert.deepEqual(split("VW Golf GTI"), { make: "VW", model: "Golf" });
  assert.equal(mobileDeMakeId("VW"), mobileDeMakeId("Volkswagen"));
  assert.equal(mobileDeMakeId("mercedes"), mobileDeMakeId("Mercedes-Benz"));
  assert.equal(mobileDeMakeId("alfa"), mobileDeMakeId("Alfa Romeo"));
  assert.equal(mobileDeMakeId("chevy"), mobileDeMakeId("Chevrolet"));
});

test("a short model code keeps the number that belongs to it", () => {
  assert.deepEqual(split("Mercedes-Benz C 200"), { make: "Mercedes-Benz", model: "C 200" });
  assert.deepEqual(split("Audi A4 Avant"), { make: "Audi", model: "A4" });
});

test("text with no make is reported rather than guessed", () => {
  assert.deepEqual(split("roter kombi mit ahk"), { make: null, model: null });
  assert.deepEqual(
    splitMakeModel({ ...EMPTY_CRITERIA, make: "Mercedes-Benz", model: "C 200" }),
    { make: "Mercedes-Benz", model: "C 200", rest: "" },
  );
});

test("mobile.de make ids come from its own selector", () => {
  assert.equal(mobileDeMakeId("Nissan"), 18700);
  assert.equal(mobileDeMakeId("Volkswagen"), 25200);
  assert.equal(mobileDeMakeId("mercedes-benz"), 17200);
  assert.equal(mobileDeMakeId("Škoda"), 22900);
  assert.equal(mobileDeMakeId("Land Rover"), mobileDeMakeId("landrover"));
  assert.equal(mobileDeMakeId("Zastava"), null, "an unlisted make is reported, not guessed");
});

test("mobile.de builds the short-form query it actually uses", () => {
  const { url, skip } = mobileDe.buildQuery(R34, 1, DE);
  assert.equal(skip, undefined);
  const q = new URL(url).searchParams;
  assert.equal(q.get("ms"), "18700;;;", "make goes in numerically");
  assert.equal(q.get("p"), "5000:100000", "ranges are min:max");
  assert.equal(q.get("ml"), "5000:200000");
  assert.equal(q.get("fr"), "1998:2002");
  assert.equal(q.get("pw"), "206", "a lone minimum is sent bare, in kilowatts");
  assert.equal(q.get("vc"), "Car");
  assert.equal(q.get("minPrice"), null, "the long-form parameters are gone");
});

test("mobile.de refuses a query it cannot express instead of fetching everything", () => {
  const vague = mobileDe.buildQuery({ ...EMPTY_CRITERIA, text: "günstiger kombi" }, 1, DE);
  assert.match(vague.skip ?? "", /keine Marke erkannt/);

  const unknown = mobileDe.buildQuery({ ...EMPTY_CRITERIA, make: "Zastava" }, 1, DE);
  assert.match(unknown.skip ?? "", /nicht gelistet/);
});

test("autoscout24 sends power in kilowatts whatever powertype says", () => {
  const { url, skip } = autoScout24.buildQuery(R34, 1, DE);
  assert.equal(skip, undefined);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/lst/nissan/skyline");
  // A real search for 280 PS sends 206. `powertype` only picks the unit shown in
  // the UI; sending 280 here means 280 kW, a floor of 381 PS.
  assert.equal(parsed.searchParams.get("powerfrom"), "206");
  assert.equal(parsed.searchParams.get("powertype"), "hp");
  assert.equal(parsed.searchParams.get("fregfrom"), "1998");
  assert.equal(parsed.searchParams.get("priceto"), "100000");
  assert.equal(parsed.searchParams.get("ustate"), "N,U");
});

test("the three portals agree on the power they are asked for", () => {
  // mobile.de and AutoScout24 take kilowatts, Kleinanzeigen takes PS. All three
  // must describe the same car.
  assert.equal(mobileDe.buildQuery(R34, 1, DE).url.includes("pw=206"), true);
  assert.equal(autoScout24.buildQuery(R34, 1, DE).url.includes("powerfrom=206"), true);
  assert.equal(kleinanzeigen.buildQuery(R34, 1, DE).url.includes("autos.power_i:280,"), true);
});

test("autoscout24 is one source that is asked about several countries", () => {
  // Eight country sites, one portal. Which of them gets queried is a search
  // criterion, not eight entries in the source list.
  assert.deepEqual([...autoScout24.markets], ["DE", "AT", "NL", "BE", "LU", "IT", "ES", "FR"]);

  const hosts = new Set<string>();
  for (const market of autoScout24.markets) {
    const parsed = new URL(autoScout24.buildQuery(R34, 1, { market, hints: {} }).url);
    hosts.add(parsed.host);
    assert.equal(parsed.pathname, "/lst/nissan/skyline", `${market} builds the same path`);
    assert.ok(parsed.searchParams.get("cy") !== null, `${market} names its country`);
  }
  assert.equal(hosts.size, autoScout24.markets.length, "each country has its own site");
});

test("the countries queried come from the search, not the source list", () => {
  const supported = [...autoScout24.markets];
  assert.deepEqual(marketsFor({ markets: [] }, supported), supported, "no choice means all of them");
  assert.deepEqual(marketsFor({ markets: ["DE", "NL"] }, supported), ["DE", "NL"]);
  assert.deepEqual(marketsFor({ markets: ["SE"] }, supported), [], "a country it does not cover");
  assert.deepEqual(marketsFor({ markets: ["DE"] }, [...kleinanzeigen.markets]), ["DE"]);
});

test("autoscout24 refuses a bare /lst that would return the whole site", () => {
  const { url, skip } = autoScout24.buildQuery(
    { ...EMPTY_CRITERIA, powerPs: { min: 280, max: null } }, 1, DE,
  );
  assert.match(skip ?? "", /keine Marke erkannt/);
  assert.ok(url.includes("/lst?"), "the url is still reported, but the run is skipped");
});

test("kleinanzeigen mixes path filters and category attributes as the site does", () => {
  const { url } = kleinanzeigen.buildQuery(R34, 1, DE);
  assert.ok(url.includes("/nissan/"), url);
  assert.ok(url.includes("/sortierung:empfohlen/"), url);
  assert.ok(url.includes("/preis:5000:100000/"), url);
  assert.ok(url.includes("/nissan-skyline-r34/"), url);
  assert.ok(url.includes("k0c216+"), url);
  assert.ok(url.includes("autos.marke_s:nissan"), url);
  assert.ok(url.includes("autos.model_s:skyline"), url);
  assert.ok(url.includes("autos.ez_i:1998,2002"), url);
  assert.ok(url.includes("autos.km_i:5000,200000"), url);
  assert.ok(url.includes("autos.power_i:280,"), url);
});

const listing = (title: string, over: Partial<RawListing["attributes"]> = {}): RawListing => ({
  sourceListingId: title, url: "https://x", title, price: 30_000,
  currency: "EUR", photoUrls: [], attributes: over,
});

test("a source that cannot search free text has its results verified afterwards", () => {
  const mixed = [
    listing("BMW 745 i Leder Xenon", { make: "BMW", model: "745" }),
    listing("Audi S6 Avant 4.2 quattro", { make: "Audi", model: "S6" }),
    listing("Nissan Skyline R34 GT-T", { make: "Nissan", model: "Skyline" }),
  ];
  const { kept } = applyUnsupported(autoScout24, R34, mixed);
  assert.deepEqual(kept.map((l) => l.title), ["Nissan Skyline R34 GT-T"]);
});

test("free text beyond the model does not discard real listings", () => {
  // The portal was asked for a Nissan Skyline; "R34" is a hint, not a filter.
  const { kept } = applyUnsupported(autoScout24, R34, [
    listing("Nissan Skyline Nismo 400 PS", { make: "Nissan", model: "Skyline" }),
    listing("Nissan Skyline R34 GT-T", { make: "Nissan", model: "Skyline" }),
    listing("BMW 745 i Leder Xenon", { make: "BMW", model: "745" }),
  ]);
  assert.deepEqual(
    kept.map((l) => l.title),
    ["Nissan Skyline Nismo 400 PS", "Nissan Skyline R34 GT-T"],
    "the make still filters, the free text no longer does",
  );
});

test("a listing missing an attribute is kept rather than silently dropped", () => {
  // Kleinanzeigen prints no power at all; requiring it would discard every result.
  const { kept } = applyUnsupported(kleinanzeigen, R34, [
    listing("Nissan Skyline R34 GT-R V-Spec"),
    listing("Opel Astra Caravan", { make: "Opel" }),
  ]);
  assert.deepEqual(kept.map((l) => l.title), ["Nissan Skyline R34 GT-R V-Spec"]);
});

test("every portal builds a usable query for a range of makes", () => {
  const wanted: ReadonlyArray<readonly [string, string, string]> = [
    ["VW Golf", "volkswagen", "golf"],
    ["Mercedes-Benz C 200", "mercedes-benz", "c-200"],
    ["Alfa Romeo Giulia", "alfa-romeo", "giulia"],
    ["Land Rover Defender", "land-rover", "defender"],
    ["Honda Jazz", "honda", "jazz"],
    ["Škoda Octavia", "skoda", "octavia"],
  ];

  for (const [text, makeSlug, modelSlug] of wanted) {
    const criteria = { ...EMPTY_CRITERIA, text };

    const as24 = autoScout24.buildQuery(criteria, 1, DE);
    assert.equal(as24.skip, undefined, `${text} was refused by AutoScout24`);
    assert.equal(new URL(as24.url).pathname, `/lst/${makeSlug}/${modelSlug}`);

    const mobile = mobileDe.buildQuery(criteria, 1, DE);
    assert.equal(mobile.skip, undefined, `${text} was refused by mobile.de`);
    assert.ok(new URL(mobile.url).searchParams.get("ms")?.startsWith(String(mobileDeMakeId(makeSlug))));

    const ka = kleinanzeigen.buildQuery(criteria, 1, DE);
    assert.ok(ka.url.includes(`autos.marke_s:${makeSlug}`), `${text}: ${ka.url}`);
  }
});

test("mobile.de translates a model name into the id its query needs", async () => {
  const form = `<select name="md"><option value="">Modell auswählen</option>
    <option value="7">Golf</option><option value="12">Passat</option>
    <option value="33">Skyline</option></select>`;

  const hints = await mobileDe.resolveHints?.(
    { ...EMPTY_CRITERIA, text: "VW Golf" },
    {
      fetchText: async () => ({ ok: true as const, value: form }),
      cached: async (_key, produce) => produce(),
    },
  );
  assert.deepEqual(hints, { modelId: "7" });

  const query = mobileDe.buildQuery({ ...EMPTY_CRITERIA, text: "VW Golf" }, 1, { market: "DE", hints: hints ?? {} });
  assert.equal(new URL(query.url).searchParams.get("ms"), "25200;7;;");
});

test("an unresolvable model still searches the make rather than failing", async () => {
  const hints = await mobileDe.resolveHints?.(
    { ...EMPTY_CRITERIA, text: "VW Kleinbus" },
    {
      fetchText: async () => ({ ok: true as const, value: '<select name="md"><option value="7">Golf</option></select>' }),
      cached: async (_key, produce) => produce(),
    },
  );
  assert.deepEqual(hints, {});
  const query = mobileDe.buildQuery({ ...EMPTY_CRITERIA, text: "VW Kleinbus" }, 1, { market: "DE", hints: hints ?? {} });
  assert.equal(new URL(query.url).searchParams.get("ms"), "25200;;;");
});

test("a rejected listing says which criterion rejected it and what it found", () => {
  // A source that can express nothing, so every criterion is verified here.
  const blind = {
    ...kleinanzeigen,
    unsupported: ["text", "powerPs", "mileageKm", "priceEur"] as const,
  };
  const strict: Criteria = {
    ...EMPTY_CRITERIA,
    text: "Nissan Skyline",
    powerPs: { min: 280, max: null },
    mileageKm: { min: null, max: 100_000 },
    priceEur: { min: null, max: 50_000 },
  };

  const { kept, dropped } = applyUnsupported(blind, strict, [
    listing("Nissan Skyline R34 GT-T", { make: "Nissan", model: "Skyline", powerW: 205_940, mileageKm: 96_000 }),
    listing("Nissan Skyline R33 GTS", { make: "Nissan", model: "Skyline", powerW: 147_000, mileageKm: 96_000 }),
    listing("Nissan Skyline Vielfahrer", { make: "Nissan", model: "Skyline", powerW: 205_940, mileageKm: 240_000 }),
    listing("Opel Astra Caravan", { make: "Opel", model: "Astra" }),
  ]);

  assert.deepEqual(kept.map((l) => l.title), ["Nissan Skyline R34 GT-T"]);
  assert.deepEqual(
    dropped.map((d) => `${d.criterion}:${d.found}`),
    ["powerPs:200 PS", "mileageKm:240000 km", "text:Opel Astra Caravan Opel Astra"],
    "each rejection names the criterion and the value that failed it",
  );
  assert.ok(dropped.every((d) => d.url !== ""), "and links to the listing that was rejected");
});
