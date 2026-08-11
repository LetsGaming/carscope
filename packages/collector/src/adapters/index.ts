import type { SourceAdapter } from "@carscope/core";
import { mobileDe } from "./mobilede.ts";
import { kleinanzeigen } from "./kleinanzeigen.ts";
import { autoScout24 } from "./autoscout24.ts";
import { autoUncle } from "./autouncle.ts";
import { mock, withLoopback } from "./mock.ts";

/** Single registry. Activation is config, never a code change. */
/** One entry per portal. Which countries a portal is asked about is a search
 *  criterion, not a separate source. */
export const ALL_ADAPTERS: readonly SourceAdapter[] = [
  mock,
  mobileDe,
  kleinanzeigen,
  autoScout24,
  autoUncle,
];

export function selectAdapters(enabledIds: readonly string[]): SourceAdapter[] {
  const wanted = new Set(enabledIds);
  return ALL_ADAPTERS.filter((a) => wanted.has(a.id));
}

export { mobileDe, kleinanzeigen, autoScout24, autoUncle, mock, withLoopback };
export { customAdapter, type CustomSource } from "./custom.ts";
