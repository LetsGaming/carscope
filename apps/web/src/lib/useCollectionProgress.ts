import { shallowRef, type ShallowRef } from "vue";
import { api } from "./api";
import type { CollectionJob } from "./types";

/** Long enough that a burst of stored offers costs one refresh, not one each. */
const REFRESH_THROTTLE_MS = 900;
const STREAM_RETRIES = 2;
const POLL_START_MS = 1_000;
const POLL_MAX_MS = 5_000;
/** A run that has not finished by now is not going to; stop watching either way. */
const WATCH_CEILING_MS = 10 * 60_000;

export interface CollectionProgress {
  readonly job: ShallowRef<CollectionJob | null>;
  /** Watches a started run to completion, calling `onProgress` as offers land. */
  follow(started: CollectionJob, onProgress: () => Promise<void> | void): Promise<void>;
}

/**
 * Following a collection run is its own concern: a stream, a polling fallback,
 * and the throttling that keeps the result list from refreshing per offer. It
 * lives apart from the workspace state so neither has to be read to understand
 * the other.
 */
export function useCollectionProgress(): CollectionProgress {
  const job = shallowRef<CollectionJob | null>(null);

  async function follow(started: CollectionJob, onProgress: () => Promise<void> | void): Promise<void> {
    job.value = started;
    await watchStream(started.done, onProgress);
  }

  async function watchStream(
    alreadySeen: number,
    onProgress: () => Promise<void> | void,
    attempt = 0,
  ): Promise<void> {
    const stream = api.jobStream();
    if (stream === null) return watchPoll(alreadySeen, onProgress);

    let seen = alreadySeen;
    let lastRefresh = 0;

    await new Promise<void>((resolve) => {
      const stop = (): void => { stream.close(); resolve(); };
      const timer = setTimeout(stop, WATCH_CEILING_MS);

      stream.addEventListener("job", (event) => {
        const next = readJob(event);
        job.value = next;
        if (next === null) return;

        // Offers arrive one at a time; refreshing per offer would be a request
        // per car, so the list catches up on a fixed cadence instead.
        if (next.stored !== seen && Date.now() - lastRefresh > REFRESH_THROTTLE_MS) {
          seen = next.stored;
          lastRefresh = Date.now();
          void onProgress();
        }
        if (next.finishedAt !== null) { clearTimeout(timer); stop(); }
      });

      stream.onerror = () => {
        clearTimeout(timer);
        stream.close();
        // A dev-server restart drops the stream. Reconnect a couple of times
        // before falling back, rather than polling for the rest of the run.
        const next = attempt < STREAM_RETRIES
          ? watchStream(seen, onProgress, attempt + 1)
          : watchPoll(seen, onProgress);
        void next.then(resolve);
      };
    });
  }

  async function watchPoll(alreadySeen: number, onProgress: () => Promise<void> | void): Promise<void> {
    let seen = alreadySeen;
    let wait = POLL_START_MS;
    const until = Date.now() + WATCH_CEILING_MS;

    while (job.value !== null && job.value.finishedAt === null && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      job.value = await api.job();
      if (job.value !== null && job.value.done !== seen) {
        seen = job.value.done;
        wait = POLL_START_MS;
        await onProgress();
      } else {
        wait = Math.min(wait * 2, POLL_MAX_MS);
      }
    }
  }

  return { job, follow };
}

/** Stream payloads are the same contract the polling endpoint serves. */
function readJob(event: Event): CollectionJob | null {
  if (!(event instanceof MessageEvent)) return null;
  const data: unknown = event.data;
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as CollectionJob | null;
  } catch {
    return null;
  }
}
