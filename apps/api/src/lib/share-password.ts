import argon2 from 'argon2';

export async function sharePasswordMatches(share: { passwordHash: string | null }, supplied: string) {
  if (!share.passwordHash) return true;
  if (!supplied) return false;
  return argon2.verify(share.passwordHash, supplied).catch(() => false);
}
