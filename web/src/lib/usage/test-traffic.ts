/** Automated checks never write usage; connector rate limits still apply. */
export function isTestTraffic(request: Request): boolean {
  if (request.headers.get('isobar-test') === '1') return true;
  const cookie = request.headers.get('cookie') ?? '';
  return cookie.split(';').some((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return false;
    return part.slice(0, separator).trim() === 'isobar-test' && part.slice(separator + 1).trim() === '1';
  });
}
