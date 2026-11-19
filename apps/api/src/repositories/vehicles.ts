import { randomUUID } from "node:crypto";
import {
  BASE_CURRENCY, DAY_MS, displayName, identityKey, inferPeriod, isSameVehicle,
  type MatchInput, type Period, type PeriodEvidence,
  type Photo, type PriceSnapshot, type RawListing, type SourceAdapter,
  type VehicleWithPrice, type Listing, type Criteria, type Market, type Vehicle,
} from "@carscope/core";
import type { ResolvedVehicle } from "@carscope/collector";
import { allRows, changed, getRow, type Db, type SqlRow } from "../db/index.ts";
import { buildFilter, HIDDEN_EXCLUDED, searchWords, textClause, type Param, type ResultRow } from "./filter.ts";
import {
  toListing, toPhoto, toSnapshot, toVehicle,
  type ListingRow, type PhotoRow, type SnapshotRow, type VehicleRow,
} from "./rows.ts";

type CandidateRow = VehicleRow & { latest_price: number | null; title: string | null };
/** A `since()` row: the search shape plus the rowid cursor and when the car was first seen. */
export type FeedRow = ResultRow & { seq: number; first_seen_at: string };
interface ObservationRow extends SqlRow { baseAmount: number; observedAt: string }
interface DetailStateRow extends SqlRow { detail_fetched_at: string | null; photos: number }
interface ListingOwnerRow extends SqlRow { vehicle_id: string }
interface CountRow extends SqlRow { n: number }
interface EvidenceRow extends SqlRow {
  with_token: number | null; with_from: number | null; with_to: number | null;
  total: number; total_from: number | null; total_to: number | null;
}

const YEAR = "CAST(substr(v.first_registration, 1, 4) AS INTEGER)";

/** Placeholder source for a vehicle that has no snapshot yet; never persisted. */
const UNKNOWN_SOURCE = "unknown";

/** Exactly the fields a detail page may overwrite. Anything else is ignored by design. */
export type VehicleDetailPatch = Partial<Pick<Vehicle,
  | "description" | "powerW" | "gearbox" | "fuel" | "sellerType"
  | "sellerName" | "mileageKm" | "firstRegistration" | "bodyStyle"
>>;

const VEHICLE_BY_ID = "SELECT * FROM vehicles WHERE id = ?";
const SNAPSHOTS_BY_VEHICLE = "SELECT * FROM price_snapshots WHERE vehicle_id = ? ORDER BY observed_at";

export class VehicleRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  findById(id: string): VehicleWithPrice | null {
    const row = getRow<VehicleRow>(this.#db.prepare(VEHICLE_BY_ID), id);
    if (row === undefined) return null;
    return this.#hydrate(row);
  }

  /**
   * Results are filtered by criteria against the whole corpus, not by which
   * saved search collected them. Saving a search schedules collection; it is not
   * a precondition for looking at what is already there.
   */
  search(criteria: Criteria, activeOnly: boolean): ResultRow[] {
    const { where, params } = buildFilter(criteria, activeOnly, this.periods(criteria, activeOnly));
    return allRows<ResultRow>(this.#db.prepare(`
      WITH latest AS (
        SELECT vehicle_id, base_amount AS amount, MAX(observed_at) AS at
        FROM price_snapshots GROUP BY vehicle_id
      ),
      earliest AS (
        SELECT vehicle_id, base_amount AS amount, MIN(observed_at) AS at
        FROM price_snapshots GROUP BY vehicle_id
      ),
      changes AS (
        SELECT vehicle_id, SUM(CASE WHEN prev IS NOT NULL AND prev <> base_amount THEN 1 ELSE 0 END) AS n
        FROM (
          SELECT vehicle_id, base_amount,
                 LAG(base_amount) OVER (PARTITION BY vehicle_id ORDER BY observed_at) AS prev
          FROM price_snapshots
        ) GROUP BY vehicle_id
      )
      SELECT
        v.id, v.make, v.model, v.variant, v.body_style, v.first_registration,
        v.mileage_km, v.power_w, v.fuel, v.gearbox, v.seller_type, v.seller_name,
        v.market, v.city, v.postal_code,
        latest.amount AS current_price,
        earliest.amount AS first_price,
        COALESCE(changes.n, 0) AS price_changes,
        v.first_listed_at,
        CAST(julianday(COALESCE(v.delisted_at, v.last_seen_at))
             - julianday(COALESCE(v.first_listed_at, v.first_seen_at)) AS INTEGER) AS days_listed,
        CASE WHEN v.first_listed_at IS NULL THEN 0 ELSE 1 END AS days_listed_exact,
        (SELECT COUNT(*) FROM photos p WHERE p.vehicle_id = v.id) AS photo_count,
        (SELECT p.local_path FROM photos p WHERE p.vehicle_id = v.id ORDER BY p.position LIMIT 1) AS thumb_path,
        (SELECT p.url FROM photos p WHERE p.vehicle_id = v.id ORDER BY p.position LIMIT 1) AS thumb_url,
        -- The sources a car was found on: the portal we fetched from, not the
        -- portal an aggregator says the advert originated on.
        (SELECT group_concat(DISTINCT l.source_id)
         FROM listings l WHERE l.vehicle_id = v.id) AS sources,
        (SELECT l.url FROM listings l WHERE l.vehicle_id = v.id ORDER BY l.first_seen_at LIMIT 1) AS listing_url
      FROM vehicles v
      JOIN latest ON latest.vehicle_id = v.id
      LEFT JOIN earliest ON earliest.vehicle_id = v.id
      LEFT JOIN changes ON changes.vehicle_id = v.id
      WHERE ${where}
      ORDER BY v.last_seen_at DESC
    `), ...params);
  }

  /**
   * The change feed a public cursor and a webhook both read: vehicles created
   * after `cursor`, oldest first. `rowid` is assigned at insert, so unlike
   * `first_seen_at` — several resolves can share a millisecond under
   * concurrency — it orders exactly as vehicles were created and every value is
   * distinct. `search()` cannot be reused here: it orders by `last_seen_at DESC`
   * for the browsing view, which would truncate the wrong end of a `LIMIT`.
   */
  since(criteria: Criteria, cursor: number, limit: number): { items: FeedRow[]; nextCursor: number | null } {
    const { where, params } = buildFilter(criteria, true);
    const rows = allRows<FeedRow>(this.#db.prepare(`
      WITH latest AS (
        SELECT vehicle_id, base_amount AS amount, MAX(observed_at) AS at
        FROM price_snapshots GROUP BY vehicle_id
      )
      SELECT
        v.rowid AS seq,
        v.id, v.make, v.model, v.variant, v.body_style, v.first_registration,
        v.mileage_km, v.power_w, v.fuel, v.gearbox, v.seller_type, v.seller_name,
        v.market, v.city, v.postal_code, v.first_seen_at,
        latest.amount AS current_price,
        NULL AS first_price, 0 AS price_changes,
        v.first_listed_at,
        CAST(julianday(COALESCE(v.delisted_at, v.last_seen_at))
             - julianday(COALESCE(v.first_listed_at, v.first_seen_at)) AS INTEGER) AS days_listed,
        CASE WHEN v.first_listed_at IS NULL THEN 0 ELSE 1 END AS days_listed_exact,
        (SELECT COUNT(*) FROM photos p WHERE p.vehicle_id = v.id) AS photo_count,
        (SELECT p.local_path FROM photos p WHERE p.vehicle_id = v.id ORDER BY p.position LIMIT 1) AS thumb_path,
        (SELECT p.url FROM photos p WHERE p.vehicle_id = v.id ORDER BY p.position LIMIT 1) AS thumb_url,
        (SELECT group_concat(DISTINCT l.source_id) FROM listings l WHERE l.vehicle_id = v.id) AS sources,
        (SELECT l.url FROM listings l WHERE l.vehicle_id = v.id ORDER BY l.first_seen_at LIMIT 1) AS listing_url
      FROM vehicles v
      JOIN latest ON latest.vehicle_id = v.id
      WHERE v.rowid > ? AND ${where}
      ORDER BY v.rowid
      LIMIT ?
    `), cursor, ...params, limit);

    const last = rows[rows.length - 1];
    return { items: rows, nextCursor: last === undefined ? null : last.seq };
  }

  observations(criteria: Criteria, sinceIso: string): { baseAmount: number; observedAt: string }[] {
    const { where, params } = buildFilter(criteria, false);
    return allRows<ObservationRow>(this.#db.prepare(`
      SELECT ps.base_amount AS baseAmount, ps.observed_at AS observedAt
      FROM price_snapshots ps
      JOIN vehicles v ON v.id = ps.vehicle_id
      WHERE ${where.replaceAll("latest.amount", "ps.base_amount")} AND ps.observed_at >= ?
      ORDER BY ps.observed_at
    `), ...params, sinceIso);
  }

/**
   * True while the detail page has not been read, and again while a vehicle has
   * at most a cover photo. Marking a fetch as done permanently means a parser
   * that improves later can never reach the cars collected before it — which is
   * how a gallery fix left every existing car with one picture.
   */
  needsDetail(vehicleId: string): boolean {
    const row = getRow<DetailStateRow>(this.#db.prepare(`
      SELECT v.detail_fetched_at,
             (SELECT COUNT(*) FROM photos p WHERE p.vehicle_id = v.id) AS photos
      FROM vehicles v WHERE v.id = ?
    `), vehicleId);
    if (row === undefined) return false;
    return row.detail_fetched_at === null || row.photos <= 1;
  }

  /**
   * The detail page fills the gaps the list page left. Attributes arrive as the
   * domain shape rather than an untyped bag, so a renamed field is a compile
   * error here instead of a column that silently stops being written.
   */
  saveDetail(vehicleId: string, attributes: VehicleDetailPatch, at: string): void {
    this.#db.prepare(`
      UPDATE vehicles SET
        description = COALESCE(?, description),
        detail_fetched_at = ?,
        power_w = COALESCE(?, power_w),
        gearbox = COALESCE(?, gearbox),
        fuel = COALESCE(?, fuel),
        seller_type = COALESCE(?, seller_type),
        seller_name = COALESCE(?, seller_name),
        mileage_km = COALESCE(?, mileage_km),
        first_registration = COALESCE(?, first_registration),
        body_style = COALESCE(?, body_style)
      WHERE id = ?
    `).run(
      attributes.description ?? null, at,
      attributes.powerW ?? null, attributes.gearbox ?? null, attributes.fuel ?? null,
      attributes.sellerType ?? null, attributes.sellerName ?? null,
      attributes.mileageKm ?? null, attributes.firstRegistration ?? null,
      attributes.bodyStyle ?? null, vehicleId,
    );
  }

  priceHistory(vehicleId: string): PriceSnapshot[] {
    return allRows<SnapshotRow>(this.#db.prepare(SNAPSHOTS_BY_VEHICLE), vehicleId).map(toSnapshot);
  }

  /**
   * Identity resolution. The coarse key narrows candidates cheaply; matchScore
   * decides, so a dealer cross-posting one car never becomes three vehicles.
   */
  resolve(
    raw: RawListing,
    adapter: SourceAdapter,
    imageHash: string | null,
    now: string,
    market: Market,
  ): ResolvedVehicle {
    // An advert already seen on this source is the same car by definition. Fuzzy
    // matching only ever runs for adverts this source has not reported before,
    // which keeps a photo-less private listing from churning a new vehicle row
    // (and a fresh price history) on every pass.
    const known = getRow<ListingOwnerRow>(this.#db.prepare(
      "SELECT vehicle_id FROM listings WHERE source_id = ? AND source_listing_id = ?",
    ), adapter.id, raw.sourceListingId);
    if (known !== undefined) {
      const current = this.#require(known.vehicle_id);
      this.#fillGaps(current, raw.attributes, raw, now);
      return { vehicle: toVehicle(this.#require(known.vehicle_id)), created: false };
    }

    const a = raw.attributes;
    // Settled once, on the way in, so one portal shouting does not put the same
    // car in the list twice over in two spellings. The identity key case-folds
    // anyway, so this changes what is read, not what is matched.
    const make = displayName(a.make ?? raw.title.split(" ")[0] ?? "unknown");
    const model = displayName(a.model ?? raw.title.split(" ").slice(1, 2).join(" ") ?? "unknown");
    const variant = a.variant === undefined || a.variant === null
      ? null
      : displayName(a.variant);
    const key = identityKey({
      make, model,
      firstRegistration: a.firstRegistration ?? null,
      mileageKm: a.mileageKm ?? null,
      market: a.market ?? market,
      sellerName: a.sellerName ?? null,
    });

    const incoming: MatchInput = {
      make, model,
      firstRegistration: a.firstRegistration ?? null,
      mileageKm: a.mileageKm ?? null,
      market: a.market ?? market,
      sellerName: a.sellerName ?? null,
      priceBase: raw.price,
      imageHash,
      powerW: a.powerW ?? null,
      title: raw.title,
    };

    const candidates = allRows<CandidateRow>(this.#db.prepare(`
      SELECT v.*, (
        SELECT ps.base_amount FROM price_snapshots ps
        WHERE ps.vehicle_id = v.id ORDER BY ps.observed_at DESC LIMIT 1
      ) AS latest_price, (
        SELECT l.title FROM listings l WHERE l.vehicle_id = v.id ORDER BY l.first_seen_at LIMIT 1
      ) AS title
      FROM vehicles v
      WHERE v.identity_key = ?
         OR (v.image_hash IS NOT NULL AND v.image_hash = ?)
         -- Same make and the exact same mileage: cheap to look up, and the only
         -- way two portals that name the model differently ever meet.
         OR (? IS NOT NULL AND v.mileage_km = ? AND lower(v.make) = lower(?))
    `), key, imageHash, a.mileageKm ?? null, a.mileageKm ?? null, make);

    for (const c of candidates) {
      const existing: MatchInput = {
        make: c.make, model: c.model,
        firstRegistration: c.first_registration,
        mileageKm: c.mileage_km,
        market: a.market ?? market,
        sellerName: c.seller_name,
        priceBase: c.latest_price ?? raw.price,
        imageHash: c.image_hash,
        powerW: c.power_w,
        title: c.title ?? [c.make, c.model, c.variant].filter(Boolean).join(" "),
      };
      if (isSameVehicle(incoming, existing)) {
        this.#fillGaps(c, a, raw, now);
        return { vehicle: toVehicle(this.#require(c.id)), created: false };
      }
    }

    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO vehicles (
        id, make, model, variant, body_style, first_registration, mileage_km, power_w,
        fuel, gearbox, seller_type, seller_name, market, postal_code, city, damaged,
        identity_key, image_hash, description, first_listed_at, first_seen_at, last_seen_at, delisted_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
    `).run(
      id, make, model, variant, a.bodyStyle ?? null, a.firstRegistration ?? null,
      a.mileageKm ?? null, a.powerW ?? null, a.fuel ?? null, a.gearbox ?? null,
      a.sellerType ?? null, a.sellerName ?? null, a.market ?? market, a.postalCode ?? null,
      a.city ?? null, a.damaged === undefined || a.damaged === null ? null : a.damaged ? 1 : 0,
      key, imageHash, a.description ?? null, a.firstListedAt ?? null, now, now,
    );

    this.#replacePhotos(id, raw.photoUrls);
    return { vehicle: toVehicle(this.#require(id)), created: true };
  }

  upsertListing(vehicleId: string, raw: RawListing, adapter: SourceAdapter, now: string): void {
    this.#db.prepare(`
      INSERT INTO listings (id, vehicle_id, source_id, source_listing_id, url, title, first_seen_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (source_id, source_listing_id)
      DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        delisted_at = NULL,
        title = excluded.title
    `).run(
      randomUUID(), vehicleId, adapter.id,
      raw.sourceListingId, raw.url, raw.title, now, now,
    );
  }

  recordPrice(s: PriceSnapshot): void {
    this.#db.prepare(`
      INSERT INTO price_snapshots (vehicle_id, observed_at, source_id, amount, currency, base_amount, rate)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING
    `).run(s.vehicleId, s.observedAt, s.sourceId, s.amount, s.currency, s.baseAmount, s.rate);
  }

  markDelisted(sourceId: string, seenIds: readonly string[], now: string, runStartedAt: string): number {
    const placeholders = seenIds.map(() => "?").join(",") || "''";
    const listings = changed(this.#db.prepare(`
      UPDATE listings SET delisted_at = ?
      WHERE source_id = ? AND delisted_at IS NULL AND source_listing_id NOT IN (${placeholders})
    `).run(now, sourceId, ...seenIds));

    // Scoped to vehicles this run did not touch. Sources collect concurrently,
    // so an unscoped sweep retires a car another source is still writing.
    this.#db.prepare(`
      UPDATE vehicles SET delisted_at = ?
      WHERE delisted_at IS NULL
        AND last_seen_at < ?
        AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.vehicle_id = vehicles.id AND l.delisted_at IS NULL)
    `).run(now, runStartedAt);

    return listings;
  }

  /** False when no such vehicle exists. Hiding twice keeps the first time. */
  hide(id: string, now: string): boolean {
    return changed(this.#db.prepare(
      "UPDATE vehicles SET hidden_at = COALESCE(hidden_at, ?) WHERE id = ?",
    ).run(now, id)) > 0;
  }

  unhide(id: string): boolean {
    return changed(this.#db.prepare(
      "UPDATE vehicles SET hidden_at = NULL WHERE id = ?",
    ).run(id)) > 0;
  }

  /** Replaces the whole set: a changed image set is a new set, not an append. */
  setImageHash(vehicleId: string, hash: string | null): void {
    this.#db.prepare("UPDATE vehicles SET image_hash = ? WHERE id = ?").run(hash, vehicleId);
  }

  savePhotos(vehicleId: string, photos: readonly { url: string; localPath: string | null; position: number }[]): void {
    this.#db.prepare("DELETE FROM photos WHERE vehicle_id = ?").run(vehicleId);
    const insert = this.#db.prepare(
      "INSERT INTO photos (vehicle_id, position, url, local_path, width, height) VALUES (?,?,?,?,NULL,NULL)",
    );
    for (const photo of photos) insert.run(vehicleId, photo.position, photo.url, photo.localPath);
  }

  #replacePhotos(vehicleId: string, urls: readonly string[]): void {
    this.savePhotos(vehicleId, urls.map((url, position) => ({ url, localPath: null, position })));
  }

  /**
   * Which of the search words name a period rather than a word an advert must
   * contain. Measured per word against the cars the rest of the search returns,
   * so it works for any make and model without a list of chassis codes.
   */
  periods(criteria: Criteria, activeOnly: boolean): Period[] {
    const words = searchWords(criteria);
    if (words.length < 2) return [];

    const found: Period[] = [];
    for (const word of words) {
      const others = words.filter((w) => w !== word);
      const evidence = this.#periodEvidence(word, others, criteria, activeOnly);
      const period = evidence === null ? null : inferPeriod(evidence);
      if (period !== null) found.push(period);
    }
    return found;
  }

  #periodEvidence(
    word: string,
    others: readonly string[],
    criteria: Criteria,
    activeOnly: boolean,
  ): PeriodEvidence | null {
    const said = textClause(word);
    const clauses: string[] = ["v.first_registration IS NOT NULL", HIDDEN_EXCLUDED];
    const params: Param[] = [];

    if (activeOnly) clauses.push("v.delisted_at IS NULL");
    for (const other of others) {
      const clause = textClause(other);
      clauses.push(clause.sql);
      params.push(...clause.params);
    }

    // The word's own clause appears three times, so its parameters lead.
    const row = getRow<EvidenceRow>(this.#db.prepare(`
      SELECT
        SUM(CASE WHEN ${said.sql} THEN 1 ELSE 0 END) AS with_token,
        MIN(CASE WHEN ${said.sql} THEN ${YEAR} END) AS with_from,
        MAX(CASE WHEN ${said.sql} THEN ${YEAR} END) AS with_to,
        COUNT(*) AS total,
        MIN(${YEAR}) AS total_from,
        MAX(${YEAR}) AS total_to
      FROM vehicles v
      WHERE ${clauses.join(" AND ")}
    `), ...said.params, ...said.params, ...said.params, ...params);

    if (row === undefined) return null;
    return {
      token: word.toLowerCase(),
      withToken: row.with_token ?? 0,
      withTokenFrom: row.with_from,
      withTokenTo: row.with_to,
      total: row.total,
      totalFrom: row.total_from,
      totalTo: row.total_to,
    };
  }

  /**
   * A second advert for a car we already have.
   *
   * The first source used to be the whole truth: a later one that knew the
   * gearbox, the seller or the description contributed nothing but a timestamp,
   * so a car listed thinly on the portal we happened to read first stayed thin
   * forever. Each column is filled only where it is still empty, so a source
   * never overwrites what another already established, and two sources
   * disagreeing cannot make a row flip back and forth between runs.
   *
   * `first_registration` is the exception: "1998-08" and "1998" are the same
   * fact at different precision, so the more precise one wins.
   *
   * Price is deliberately absent. It belongs to a listing, not to the car, and
   * lives in price_snapshots per source.
   */
  #fillGaps(current: VehicleRow, a: RawListing["attributes"], raw: RawListing, now: string): void {
    const better = (a.firstRegistration ?? "").length > (current.first_registration ?? "").length
      ? a.firstRegistration ?? null
      : null;

    this.#db.prepare(`
      UPDATE vehicles SET
        last_seen_at = ?,
        delisted_at = NULL,
        first_listed_at = COALESCE(first_listed_at, ?),
        first_registration = COALESCE(?, first_registration, ?),
        variant = COALESCE(variant, ?),
        body_style = COALESCE(body_style, ?),
        mileage_km = COALESCE(mileage_km, ?),
        power_w = COALESCE(power_w, ?),
        fuel = COALESCE(fuel, ?),
        gearbox = COALESCE(gearbox, ?),
        seller_type = COALESCE(seller_type, ?),
        seller_name = COALESCE(seller_name, ?),
        postal_code = COALESCE(postal_code, ?),
        city = COALESCE(city, ?),
        damaged = COALESCE(damaged, ?),
        description = COALESCE(description, ?)
      WHERE id = ?
    `).run(
      now, a.firstListedAt ?? null,
      better, a.firstRegistration ?? null,
      a.variant === undefined || a.variant === null ? null : displayName(a.variant),
      a.bodyStyle ?? null, a.mileageKm ?? null, a.powerW ?? null,
      a.fuel ?? null, a.gearbox ?? null, a.sellerType ?? null, a.sellerName ?? null,
      a.postalCode ?? null, a.city ?? null,
      a.damaged === undefined || a.damaged === null ? null : a.damaged ? 1 : 0,
      a.description ?? null,
      current.id,
    );

    // A source with more pictures than the one we read first is worth keeping.
    if (raw.photoUrls.length > this.#photoCount(current.id)) {
      this.#replacePhotos(current.id, raw.photoUrls);
    }
  }

  #photoCount(vehicleId: string): number {
    const row = getRow<CountRow>(this.#db.prepare(
      "SELECT COUNT(*) AS n FROM photos WHERE vehicle_id = ?",
    ), vehicleId);
    return row?.n ?? 0;
  }

  /** A row the caller has just written or resolved; its absence is a broken invariant. */
  #require(id: string): VehicleRow {
    const row = getRow<VehicleRow>(this.#db.prepare(VEHICLE_BY_ID), id);
    if (row === undefined) throw new Error(`vehicle ${id} vanished mid-write`);
    return row;
  }

  #hydrate(row: VehicleRow): VehicleWithPrice {
    const snapshots = allRows<SnapshotRow>(this.#db.prepare(SNAPSHOTS_BY_VEHICLE), row.id);
    const photos: Photo[] = allRows<PhotoRow>(this.#db.prepare(
      "SELECT * FROM photos WHERE vehicle_id = ? ORDER BY position",
    ), row.id).map(toPhoto);
    const listings: Listing[] = allRows<ListingRow>(this.#db.prepare(
      "SELECT * FROM listings WHERE vehicle_id = ? ORDER BY first_seen_at",
    ), row.id).map((l) => toListing(l, photos));

    const prices = snapshots.map(toSnapshot);
    const first = prices[0];
    const current = prices[prices.length - 1];
    const fallback: PriceSnapshot = {
      vehicleId: row.id, observedAt: row.first_seen_at, sourceId: UNKNOWN_SOURCE,
      amount: 0, currency: BASE_CURRENCY, baseAmount: 0, rate: 1,
    };

    let changes = 0;
    for (let i = 1; i < prices.length; i += 1) {
      if (prices[i]?.baseAmount !== prices[i - 1]?.baseAmount) changes += 1;
    }

    const end = row.delisted_at ?? row.last_seen_at;
    return {
      ...toVehicle(row),
      currentPrice: current ?? fallback,
      firstPrice: first ?? fallback,
      priceChangeCount: changes,
      daysListed: Math.max(0, Math.round((Date.parse(end) - Date.parse(row.first_seen_at)) / DAY_MS)),
      listings,
      photos,
    };
  }
}
