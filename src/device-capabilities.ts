export function shouldOfferDirectCameraCapture(
  userAgent: string,
  maxTouchPoints: number,
): boolean {
  if (/Android|iPhone|iPad|iPod/iu.test(userAgent)) return true;

  // iPadOS can request desktop sites and identify itself as Macintosh.
  return /Macintosh/iu.test(userAgent) && maxTouchPoints > 1;
}
