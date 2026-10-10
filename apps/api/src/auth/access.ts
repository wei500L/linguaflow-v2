export type AccessUser = { id: string; role: string; tokenVersion: number };
export type AccessClaims = { sub?: string; role?: string; tv?: number };

export function accessClaims(user: AccessUser) {
  return { sub: user.id, role: user.role, tv: user.tokenVersion };
}

/* Missing tv is the version written before this column existed. */
export function accessStillValid(user: { id: string; role: string; tokenVersion: number } | undefined, claims: AccessClaims) {
  if (!user || !claims.sub || claims.sub !== user.id) return null;
  if ((claims.tv ?? 0) !== user.tokenVersion) return null;
  return accessClaims(user);
}
