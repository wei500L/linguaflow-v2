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
  /* Assigning an absolute scrollTop twice is what actually sticks on iOS.
     Adding the distance once often lands on the spacer and hides the new line. */
  const pin = () => { el.scrollTop = el.scrollHeight; };
  pin();
  requestAnimationFrame(() => {
    pin();
    requestAnimationFrame(() => { flag.current = false; });
  });
}
