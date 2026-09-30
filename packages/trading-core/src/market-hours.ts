/**
 * NSE/BSE cash & F&O session helpers in IST (UTC+05:30, no DST).
 * Holidays MUST be loaded from the exchange calendar each year (config/D1), never hard-coded here.
 */
const IST_OFFSET_MIN = 330;

export interface SessionConfig {
  /** Crypto markets trade 24x7: no pre-open, no square-off, no holidays. */
  alwaysOpen?: boolean;
  preOpenStart: string; // "09:00"
  open: string; // "09:15"
  noNewEntriesAfter: string; // "15:00" — our own rule
  squareOffAt: string; // "15:10" — exit intraday before broker auto square-off
  close: string; // "15:30"
  holidays: readonly string[]; // "YYYY-MM-DD" (IST)
}

export const DEFAULT_SESSION: SessionConfig = {
  preOpenStart: "09:00",
  open: "09:15",
  noNewEntriesAfter: "15:00",
  squareOffAt: "15:10",
  close: "15:30",
  holidays: [],
};

export interface IstParts {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since IST midnight
  weekday: number; // 0 = Sunday
}

export function toIst(epochMs: number): IstParts {
  const d = new Date(epochMs + IST_OFFSET_MIN * 60_000);
  const date = d.toISOString().slice(0, 10);
  return { date, minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}

function hm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export type SessionPhase = "CLOSED" | "PRE_OPEN" | "OPEN" | "NO_NEW_ENTRIES" | "SQUARE_OFF";

export const CRYPTO_SESSION: SessionConfig = { ...DEFAULT_SESSION, alwaysOpen: true, holidays: [] };

export function sessionPhase(epochMs: number, cfg: SessionConfig = DEFAULT_SESSION): SessionPhase {
  if (cfg.alwaysOpen) return "OPEN";
  const { date, minutes, weekday } = toIst(epochMs);
  if (weekday === 0 || weekday === 6 || cfg.holidays.includes(date)) return "CLOSED";
  if (minutes >= hm(cfg.close) || minutes < hm(cfg.preOpenStart)) return "CLOSED";
  if (minutes < hm(cfg.open)) return "PRE_OPEN";
  if (minutes >= hm(cfg.squareOffAt)) return "SQUARE_OFF";
  if (minutes >= hm(cfg.noNewEntriesAfter)) return "NO_NEW_ENTRIES";
  return "OPEN";
}

export function canOpenNewPosition(epochMs: number, cfg: SessionConfig = DEFAULT_SESSION): boolean {
  return sessionPhase(epochMs, cfg) === "OPEN";
}
