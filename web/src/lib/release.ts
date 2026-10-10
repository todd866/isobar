export interface ReleaseFile {
  url?: unknown;
  status?: unknown;
}

/** A download is offered only when release.json names an https URL. */
export function downloadHref(release: ReleaseFile | null | undefined): string | null {
  if (!release || typeof release.url !== 'string') return null;
  const url = release.url.trim();
  if (!url.startsWith('https://')) return null;
  return url;
}
