export type PausableAudio = { pause: () => void };

export function pauseOtherAudioPlayers(
  current: PausableAudio,
  players: Iterable<PausableAudio>,
): number {
  let paused = 0;
  for (const player of players) {
    if (player === current) continue;
    player.pause();
    paused += 1;
  }
  return paused;
}
