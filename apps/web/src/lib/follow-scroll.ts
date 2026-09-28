export function lockProgrammaticScroll(flag: { current: boolean }) {
  flag.current = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { flag.current = false; });
  });
}

export function nudgeToBottom(el: HTMLElement, flag: { current: boolean }) {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distance <= 1) return;
  flag.current = true;
  el.scrollTop += distance;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { flag.current = false; });
  });
}
