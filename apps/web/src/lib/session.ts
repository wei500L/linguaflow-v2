export function shouldRefreshAccessToken(sessionRunning: boolean, expiresWithinWindow: boolean) {
  return sessionRunning && expiresWithinWindow;
}
