export const INDIA_TIME_ZONE = "Asia/Kolkata";

export function isoDateInTimeZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function indiaIsoDate(value: Date = new Date()): string {
  return isoDateInTimeZone(value, INDIA_TIME_ZONE);
}

export function recordingDateInputDetails(
  value: Date = new Date(),
  deviceTimeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): { maximumDate: string; indiaDateNote: string | null } {
  const maximumDate = indiaIsoDate(value);
  if (isoDateInTimeZone(value, deviceTimeZone) === maximumDate) {
    return { maximumDate, indiaDateNote: null };
  }
  const displayDate = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: INDIA_TIME_ZONE,
  }).format(value);
  return { maximumDate, indiaDateNote: `Date in India: ${displayDate}.` };
}
