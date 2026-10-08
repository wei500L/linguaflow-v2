import { useEffect, useState } from 'react';

/* The single source of truth for layout breakpoints. CSS uses the mirrored
   min-width values (640px and 1024px) in styles/; nothing else should hardcode a width. */

/** Phone layout: below the 640px CSS breakpoint. */
export const PHONE_QUERY = '(max-width: 639.98px)';

/** Below the desktop breakpoint, covering phones and small tablets. */
export const COMPACT_QUERY = '(max-width: 1023.98px)';

/** A personal screen rather than a projector, which is what /live switches on. */
export const READING_QUERY = '(max-width: 1099px)';

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Tracks the visual viewport so the shell stays inside the area the user can
    actually see. iOS moves that area when the keyboard or browser chrome shows,
    and a shell taller than it hides the start button. */
export function useViewportHeight() {
  useEffect(() => {
    const apply = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
    };
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      window.visualViewport?.removeEventListener('resize', apply);
      window.visualViewport?.removeEventListener('scroll', apply);
      document.documentElement.style.removeProperty('--app-height');
    };
  }, []);
}
