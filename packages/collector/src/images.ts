import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { HttpClient } from "./http.ts";

export const MAX_PHOTOS_PER_VEHICLE = 6;
export const MAX_PHOTO_BYTES = 1_500_000;

const VARIANTS: ReadonlyArray<readonly [RegExp, string]> = [
  // Kleinanzeigen and mobile.de both name a size rule in the query string.
  [/([?&]rule=)\$_\d+\.(AUTO|JPG|WEBP)/i, "$1$_57.$2"],
  [/([?&]rule=)mo-\d+/i, "$1mo-720"],
  // AutoScout24 encodes the size as a trailing path segment.
  [/\/\d{3,4}x\d{3,4}\.(jpe?g|webp|png)$/i, "/640x480.$1"],
];

/**
 * Portals serve several sizes of the same asset. A gallery-sized copy is enough
 * to judge a car and roughly an order of magnitude smaller than the original,
 * which is the difference between a few hundred megabytes and tens of gigabytes
 * over a couple of years.
 */
export function mediumVariant(url: string): string {
  for (const [pattern, replacement] of VARIANTS) {
    if (pattern.test(url)) return url.replace(pattern, replacement);
  }
  return url;
}

export interface StoredPhoto {
  readonly url: string;
  /** Relative to the data directory and served under /media, or null if the fetch failed. */
  readonly localPath: string | null;
  readonly position: number;
}

/**
 * A resize proxy carries the picture in a parameter:
 * `images.autouncle.com/de/resize?url=de%2Fcar_images%2F<id>_1999-nissan.webp&w=400`.
 * Cutting the query off left `de/resize` for every picture, so all cards of the
 * portal shared one hash, and any two with the same price and title merged.
 */
function assetOf(url: string): string {
  const inner = /[?&](?:amp;)?url=([^&]+)/.exec(url)?.[1];
  if (inner === undefined) return url;
  try {
    return decodeURIComponent(inner);
  } catch {
    return url;
  }
}

/**
 * Cheap perceptual proxy: the ordered set of source image URLs, stripped of
 * size and cache tokens. Dealers cross-posting the same car reuse the same asset
 * paths, which is what makes cross-portal dedup work before anything is fetched.
 */
export function imageSetHash(urls: readonly string[]): string | null {
  if (urls.length === 0) return null;
  const normalised = urls
    .slice(0, MAX_PHOTOS_PER_VEHICLE)
    .map((u) => assetOf(u).replace(/\/\d+x\d+(?=\.\w+$)/, "").replace(/\?.*$/, "").split("/").slice(-2).join("/"))
    .sort();
  return createHash("sha1").update(normalised.join("|")).digest("hex").slice(0, 16);
}

/**
 * The extension follows the bytes, not the URL, and only raster formats are
 * recognised. Photos are fetched from portals and then served from our own
 * origin, so anything that can carry script — an SVG, or an unknown format a
 * browser might sniff as one — is refused rather than stored under /media.
 */
function extensionFor(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return "webp";
  return null;
}

export function photoDir(vehicleId: string): string {
  return posix.join("photos", vehicleId.slice(0, 2), vehicleId);
}

/**
 * Downloads a vehicle's photos once and keeps them. A listing outlives its
 * images by minutes after delisting, so a remote URL is worthless the moment the
 * history becomes interesting.
 */
export class PhotoStore {
  readonly #http: HttpClient;
  readonly #dataDir: string;

  constructor(http: HttpClient, dataDir: string) {
    this.#http = http;
    this.#dataDir = dataDir;
  }

  async ensure(vehicleId: string, urls: readonly string[]): Promise<StoredPhoto[]> {
    const wanted = urls.slice(0, MAX_PHOTOS_PER_VEHICLE);
    await mkdir(join(this.#dataDir, photoDir(vehicleId)), { recursive: true });

    // A gallery is a handful of independent files; fetching them in sequence
    // makes one car take longer than the search that found it.
    return Promise.all(wanted.map(async (url, position): Promise<StoredPhoto> => {
      const res = await this.#http.getBinary(mediumVariant(url), MAX_PHOTO_BYTES);
      if (!res.ok) return { url, localPath: null, position };

      const extension = extensionFor(res.value);
      // Not a picture: the listing keeps the remote URL and nothing is stored.
      if (extension === null) return { url, localPath: null, position };

      const relative = posix.join(photoDir(vehicleId), `${String(position)}.${extension}`);
      await writeFile(join(this.#dataDir, relative), res.value);
      return { url, localPath: relative, position };
    }));
  }
}
