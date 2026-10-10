/* Gmail delivers dots, plus-tags and googlemail.com to one inbox.
   Other providers keep the address as typed, so a plus-tag there stays a
   separate account and an existing user can still sign in. */
export function canonicalEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return normalized;
  const domain = normalized.slice(at + 1);
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return normalized;
  const local = normalized.slice(0, at).split('+')[0].replace(/\./g, '');
  return `${local}@gmail.com`;
}

/* Plus-tags stay distinct at login for non-Gmail inboxes. Referral rewards
   collapse them so a+1 and a+2 cannot each collect a grant. */
export function referralIdentity(email: string) {
  const canonical = canonicalEmail(email);
  const at = canonical.lastIndexOf('@');
  if (at <= 0) return canonical;
  return `${canonical.slice(0, at).split('+')[0]}@${canonical.slice(at + 1)}`;
}
