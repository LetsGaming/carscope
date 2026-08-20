import { createHmac } from "node:crypto";
import type { Criteria } from "@carscope/core";
import type { WebhookRepository, WebhookRow } from "../repositories/webhooks.ts";
import type { VehicleRepository } from "../repositories/vehicles.ts";
import type { SearchRepository } from "../repositories/searches.ts";
import { toPublicFeedVehicle } from "../routes/public/dto.ts";

export interface WebhookDispatcherOptions {
  readonly timeoutMs: number;
  readonly maxItems: number;
  readonly maxFailures: number;
}

/**
 * Dispatches from a durable DB watermark (`webhooks.notified_through`), never
 * from a collector-side hook. The stall watchdog in `plugins/collector.ts`
 * races an adapter but does not cancel the loser, so an abandoned worker keeps
 * inserting vehicles for minutes after a job "finishes" — any in-run hook would
 * silently miss those. Reading the same `since()` cursor the public feed uses
 * means the webhook and a polling browser can never disagree about what "new"
 * means, and a crash mid-run loses nothing: the next run's window covers it.
 */
export class WebhookDispatcher {
  readonly #webhooks: WebhookRepository;
  readonly #vehicles: VehicleRepository;
  readonly #searches: SearchRepository;
  readonly #opts: WebhookDispatcherOptions;
  readonly #now: () => Date;

  constructor(
    webhooks: WebhookRepository,
    vehicles: VehicleRepository,
    searches: SearchRepository,
    opts: WebhookDispatcherOptions,
    now: () => Date = () => new Date(),
  ) {
    this.#webhooks = webhooks;
    this.#vehicles = vehicles;
    this.#searches = searches;
    this.#opts = opts;
    this.#now = now;
  }

  /**
   * Called after a collection run finishes, for the search it ran against. An
   * `adhoc-*` job id simply has no rows in `webhooks` (it is keyed by
   * `search_id`), so this is a no-op for those without special-casing the id.
   */
  async afterRun(searchId: string): Promise<void> {
    const search = this.#searches.findById(searchId);
    if (search === null) return;
    const hooks = this.#webhooks.listEnabledFor(searchId);
    if (hooks.length === 0) return;

    await Promise.allSettled(hooks.map((hook) => this.#deliver(hook, search.criteria)));
  }

  async #deliver(hook: WebhookRow, criteria: Criteria): Promise<void> {
    const { items, nextCursor } = this.#vehicles.since(criteria, hook.notified_through, this.#opts.maxItems);
    if (items.length === 0 || nextCursor === null) return;

    const at = this.#now().toISOString();
    const body = JSON.stringify({
      searchId: hook.search_id,
      items: items.map(toPublicFeedVehicle),
    });
    const signature = createHmac("sha256", hook.secret).update(`${at}.${body}`).digest("hex");

    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-carscope-timestamp": at,
          "x-carscope-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
        // A redirect could quietly point the payload somewhere the operator
        // never registered; treat it as a delivery failure instead of following it.
        redirect: "error",
      });
      if (res.ok) {
        this.#webhooks.advance(hook.id, nextCursor, at);
      } else {
        this.#webhooks.recordFailure(hook.id, res.status, at, this.#opts.maxFailures);
      }
    } catch {
      this.#webhooks.recordFailure(hook.id, null, at, this.#opts.maxFailures);
    }
  }
}
