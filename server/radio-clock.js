// Deterministic shuffle: every visitor uses the same order for each broadcast round.
export function scheduledPosition(radio, serverNowMs) {
  const total = radio.tracks.reduce((sum, track) => sum + track.duration, 0);
  if (!total) return null;
  const elapsed = (serverNowMs - radio.epochMs) / 1000;
  const cycle = Math.floor(elapsed / total);
  let position = ((elapsed % total) + total) % total;
  const order = Array.from({ length: radio.tracks.length }, (_, i) => i);
  if (radio.shuffle) {
    let seed = 2166136261;
    for (const character of `${radio.epochMs}:${cycle}`) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
    const random = () => {
      seed = (seed + 0x6D2B79F5) >>> 0;
      let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
      value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  for (const index of order) {
    if (position < radio.tracks[index].duration) return { index, seconds: position };
    position -= radio.tracks[index].duration;
  }
  return null;
}
