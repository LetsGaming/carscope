import { EMPTY_CRITERIA, convert, identityKey, psToWatt, type Criteria } from "@carscope/core";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { MAX_PHOTOS_PER_VEHICLE, photoDir } from "@carscope/collector";
import { openDatabase, transaction } from "./index.ts";
import { loadConfig } from "../config.ts";

/**
 * Generates a plausible two-year history so the market view can be judged before
 * real collection has produced one. Deterministic, and it only ever runs against
 * an explicitly named database.
 */
const MONTHS = 24;
const BASE_PRICE = 34_600;
const YEARLY_DRIFT = 4_200;
const SPREAD = 5_600;
const DAY_MS = 86_400_000;

let seed = 20_260_805;
const rnd = (): number => (seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296) / 4_294_967_296;
const gauss = (): number => (rnd() + rnd() + rnd() + rnd() - 2) / 1.6;

const CITIES = [
  ["Venlo", "NL"], ["Hamburg", "DE"], ["Antwerpen", "BE"],
  ["München", "DE"], ["Rotterdam", "NL"], ["Malmö", "SE"],
] as const;

/** Stock GT-T is 206 PS; the rest are the usual turbo-back and ECU jobs. */
const POWER_PS = [206, 206, 206, 220, 245, 260, 280, 190] as const;
const PHOTO_COUNTS = [0, 1, 3, 4, 6, 8, 8, 8] as const;

const pickFrom = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;

const config = loadConfig();
const db = openDatabase(config.databaseFile);

const insertPhoto = db.prepare(
  "INSERT INTO photos (vehicle_id, position, url, local_path, width, height) VALUES (?,?,?,?,?,?)",
);

const BODY_TONES = [
  ["#2f3a44", "#5b6b78"], ["#4a3d38", "#7d6a5e"], ["#33453c", "#5f7a6c"],
  ["#453040", "#75566c"], ["#3b3f2e", "#6b7154"], ["#2c3b46", "#54707f"],
] as const;

/**
 * Writes real files into the photo store so the seeded UI exercises the same
 * path a collected photo takes, rather than falling back to the placeholder.
 */
function writePhotos(vehicleId: string, count: number, coupe: boolean, powerPs: number): void {
  if (count === 0) return;
  const stored = Math.min(count, MAX_PHOTOS_PER_VEHICLE);
  const dir = join(config.dataDir, photoDir(vehicleId));
  mkdirSync(dir, { recursive: true });

  for (let i = 0; i < stored; i += 1) {
    const tone = BODY_TONES[(vehicleId.charCodeAt(0) + i) % BODY_TONES.length] ?? BODY_TONES[0];
    const relative = posix.join(photoDir(vehicleId), `${String(i)}.svg`);
    writeFileSync(join(config.dataDir, relative), carSvg(tone[0], tone[1], coupe, powerPs, i));
    insertPhoto.run(vehicleId, i, `https://example.invalid/${vehicleId}/${String(i)}.jpg`, relative, 800, 500);
  }
}

function carSvg(dark: string, light: string, coupe: boolean, powerPs: number, index: number): string {
  const roof = coupe ? "M63 32 L78 20 C82 17 88 16 98 16 L112 16 L112 32 Z" : "M63 32 L76 21 C79 18 84 17 93 17 L104 17 L104 32 Z";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80" width="800" height="320">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs>
  <rect width="200" height="80" fill="url(#g)"/>
  <ellipse cx="100" cy="74" rx="86" ry="6" fill="#00000026"/>
  <path d="M8 62 L11 46 C13 39 22 35 38 33 L58 19 C63 15 72 13 88 13 L116 13 C130 13 140 16 148 22 L164 33 C180 35 190 40 192 48 L193 62 Z" fill="#12151a" opacity=".85"/>
  <path d="${roof}" fill="${light}" opacity=".5"/>
  <circle cx="52" cy="62" r="14" fill="#12151a"/><circle cx="52" cy="62" r="6" fill="${light}" opacity=".6"/>
  <circle cx="152" cy="62" r="14" fill="#12151a"/><circle cx="152" cy="62" r="6" fill="${light}" opacity=".6"/>
  <text x="6" y="12" font-family="system-ui" font-size="7" fill="${light}" opacity=".85">${String(powerPs)} PS · Foto ${String(index + 1)}</text>
</svg>`;
}

const criteria: Criteria = {
  ...EMPTY_CRITERIA,
  make: "Nissan", model: "Skyline", text: "R34 GT-T",
  priceEur: { min: 25_000, max: 60_000 },
  registrationYear: { min: 1998, max: 2002 },
  markets: ["DE", "NL", "BE", "SE"],
};

const searchId = randomUUID();
const now = new Date();
db.prepare("INSERT INTO searches (id, name, criteria, created_at, updated_at) VALUES (?,?,?,?,?)")
  .run(searchId, "R34 GT-T · EU", JSON.stringify(criteria), now.toISOString(), now.toISOString());

const insertVehicle = db.prepare(`
  INSERT INTO vehicles (
    id, make, model, variant, body_style, first_registration, mileage_km, power_w,
    fuel, gearbox, seller_type, seller_name, market, postal_code, city, damaged,
    identity_key, image_hash, description, first_listed_at, first_seen_at, last_seen_at, delisted_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const insertListing = db.prepare(`
  INSERT INTO listings (id, vehicle_id, source_id, source_listing_id, url, title, first_seen_at, last_seen_at, delisted_at)
  VALUES (?,?,?,?,?,?,?,?,?)
`);
const insertPrice = db.prepare(`
  INSERT INTO price_snapshots (vehicle_id, observed_at, source_id, amount, currency, base_amount, rate)
  VALUES (?,?,?,?,?,?,?)
`);
const insertRun = db.prepare(`
  INSERT INTO runs (source_id, search_id, started_at, finished_at, fetched, kept, created, merged, delisted, status, note)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);

let created = 0;

transaction(db, () => {
  for (let m = 0; m < MONTHS; m += 1) {
    const t = m / (MONTHS - 1);
    const median = BASE_PRICE + YEARLY_DRIFT * t + 800 * Math.sin(t * 5);
    const listedThisMonth = Math.round(2 + 5 * t + rnd() * 3);

    for (let k = 0; k < listedThisMonth; k += 1) {
      const start = new Date(now.getTime() - (MONTHS - m) * 30 * DAY_MS - Math.floor(rnd() * 20) * DAY_MS);
      const lifespanDays = 25 + Math.floor(rnd() * 120);
      const stillListed = start.getTime() + lifespanDays * DAY_MS > now.getTime();
      const place = CITIES[Math.floor(rnd() * CITIES.length)] ?? CITIES[0];
      const coupe = rnd() < 0.4;
      const mileage = 55_000 + Math.floor(rnd() * 110_000);
      const registration = `${1998 + Math.floor(rnd() * 5)}-0${1 + Math.floor(rnd() * 9)}`;

      const powerPs = pickFrom(POWER_PS);
      const gearbox = rnd() < 0.7 ? "manual" : "automatic";
      const photoCount = pickFrom(PHOTO_COUNTS);
      const tuned = powerPs > 210;

      let price = Math.round(
        (median + gauss() * SPREAD + (coupe ? 4_000 : 0) + (tuned ? -1_800 : 0)) / 100,
      ) * 100;
      const id = randomUUID();
      const source = place[1] === "NL" ? "marktplaats" : place[1] === "DE" ? "mobile.de" : "autoscout24.be";

      insertVehicle.run(
        id, "Nissan", "Skyline", "GT-T", coupe ? "coupe" : "sedan", registration,
        mileage, psToWatt(powerPs), "petrol", gearbox, rnd() < 0.5 ? "dealer" : "private",
        rnd() < 0.5 ? "JDM Import Venlo" : null, place[1], null, place[0], 0,
        identityKey({
          make: "Nissan", model: "Skyline", firstRegistration: registration,
          mileageKm: mileage, market: place[1], sellerName: null,
        }),
        null,
        `Importfahrzeug aus Japan. ${String(powerPs)} PS, ${gearbox === "manual" ? "Schaltgetriebe" : "Automatik"}. `
          + "Scheckheft vorhanden, TÜV neu, keine Unfallschäden. Besichtigung nach Absprache.",
        start.toISOString().slice(0, 10),
        start.toISOString(),
        stillListed ? now.toISOString() : new Date(start.getTime() + lifespanDays * DAY_MS).toISOString(),
        stillListed ? null : new Date(start.getTime() + lifespanDays * DAY_MS).toISOString(),
      );

      insertListing.run(
        randomUUID(), id, source, `seed-${created}`, `https://example.invalid/${id}`,
        "Nissan Skyline R34 GT-T", start.toISOString(),
        stillListed ? now.toISOString() : new Date(start.getTime() + lifespanDays * DAY_MS).toISOString(),
        stillListed ? null : new Date(start.getTime() + lifespanDays * DAY_MS).toISOString(),
      );
      writePhotos(id, photoCount, coupe, powerPs);

      // Snapshot every six hours, with the occasional reduction, as a collector would.
      const observations = Math.min(lifespanDays, Math.floor((now.getTime() - start.getTime()) / DAY_MS));
      for (let d = 0; d <= observations; d += 7) {
        if (d > 0 && rnd() < 0.08) price = Math.round((price * 0.965) / 100) * 100;
        const at = new Date(start.getTime() + d * DAY_MS).toISOString();
        const money = convert(price, "EUR", 1);
        insertPrice.run(id, at, source, money.amount, money.currency, money.baseAmount, money.rate);
      }
      created += 1;
    }
  }

  for (const source of ["mobile.de", "marktplaats", "autoscout24.be"]) {
    insertRun.run(source, searchId, now.toISOString(), now.toISOString(), created, created, created, 0, 0, "ok", null);
  }
  insertRun.run(
    "autoscout24.de", searchId, now.toISOString(), now.toISOString(),
    0, 0, 0, 0, 0, "blocked", "autoscout24.de served a bot challenge",
  );
});

db.close();
process.stdout.write(`seeded ${String(created)} vehicles across ${String(MONTHS)} months into ${config.databaseFile}\n`);
