import { type ReactNode } from 'react';

export type Notice = { id: string; node: ReactNode };

/* Only the most important notice is shown. The banners used to stack as siblings
   of the caption surface, so three at once could squeeze captions out of a phone
   screen entirely. */
export function SessionNotices({ notices }: { notices: Array<Notice | null> }) {
  const first = notices.find((notice): notice is Notice => Boolean(notice));
  if (!first) return null;
  return <div className="notice-slot">{first.node}</div>;
}
