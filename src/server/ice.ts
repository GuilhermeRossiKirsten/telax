export function getIceServers(env: Record<string, string | undefined>): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  const { TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } = env;
  if (TURN_URLS && TURN_USERNAME && TURN_CREDENTIAL) {
    const urls = TURN_URLS.split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length > 0) servers.push({ urls, username: TURN_USERNAME, credential: TURN_CREDENTIAL });
  }
  return servers;
}
