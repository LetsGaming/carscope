import type { Photo } from "@carscope/core";

export const MEDIA_PREFIX = "/media/";

/** A stored photo is served locally; an unfetched one still points at the source. */
export function photoUrl(photo: Photo): string {
  return photo.localPath === null ? photo.url : MEDIA_PREFIX + photo.localPath;
}
