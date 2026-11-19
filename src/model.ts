export const URL_QUEUE = "https://munich.pasport.org.ua/solutions/e-queue";
export const SERVICE = "Закордонний паспорт та (або) ID-картка";
export const FULL = "Вибачте, на даний момент всі місця зайняті!";
export type Slot = { date: string; time: string };
export type Result =
  | { status: "AVAILABLE"; slots: Slot[] }
  | { status: "UNAVAILABLE" }
  | { failure: "UNVERIFIED" | "ERROR"; reason: string; retryAt?: number };
export class Problem extends Error {
  constructor(
    readonly kind: "UNVERIFIED" | "ERROR",
    reason: string,
    readonly retryable = false,
    readonly retryAt?: number,
  ) {
    super(reason);
  }
}
export function object(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
export function httpStatus(status: number, retryAfter?: string) {
  if ((status === 429 || status === 503) && retryAfter) {
    const until = /^\d+$/.test(retryAfter)
      ? Date.now() + Number(retryAfter) * 1000
      : Date.parse(retryAfter);
    if (Number.isSafeInteger(until) && until > Date.now())
      throw new Problem(
        status === 429 ? "UNVERIFIED" : "ERROR",
        "HTTP " + status + " с Retry-After",
        false,
        until,
      );
  }
  if ([401, 403, 429].includes(status))
    throw new Problem("UNVERIFIED", "HTTP " + status);
  if (status !== 200)
    throw new Problem("ERROR", "HTTP " + status, status >= 500);
}
export type Choice = { value: string; label: string };
export function choices(
  payload: unknown,
  kind: "days" | "timeSlots",
): Choice[] {
  if (!object(payload) || !Array.isArray(payload[kind]))
    throw new Problem("UNVERIFIED", "Неизвестный формат " + kind);
  const options = new Map<string, string>();
  for (const row of payload[kind]) {
    if (!object(row) || typeof row.isAllowed !== "boolean")
      throw new Problem("UNVERIFIED", "Изменился формат isAllowed");
    if (!row.isAllowed) continue;
    const [value, label] =
      kind === "days" ? [row.datePart, row.date] : [row.startTime, row.slot];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      typeof label !== "string" ||
      !label.trim() ||
      options.has(value)
    )
      throw new Problem("UNVERIFIED", "Неоднозначные варианты в " + kind);
    options.set(value, label.trim());
  }
  return Array.from(options, ([value, label]) => ({ value, label }));
}
export function dateKey(value: string) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const local = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  const date = iso
    ? value
    : local
      ? [local[3], local[2], local[1]].join("-")
      : "";
  const parsed = Date.parse(date);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== date
  )
    throw new Problem("UNVERIFIED", "Неизвестная дата");
  return date;
}
export function timeKey(value: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value))
    throw new Problem("UNVERIFIED", "Неизвестное время");
  return value.slice(0, 5);
}
export function summarize(slots: Slot[]): Result {
  return slots.length
    ? { status: "AVAILABLE", slots }
    : { status: "UNAVAILABLE" };
}
export const slotKey = (s: Slot) => s.date + " " + s.time;
