/**
 * KESCO regulated household tariffs (Kosovo), as published at
 * https://fatura.kesco-energy.com/Static/TariffGroupPrices and read in
 * October 2026. The regulator (ERO/ZRRE) normally revises them once a year;
 * when that happens, change the numbers here.
 *
 * Prices are euro cents per kWh. The page states no VAT, so the 8% that applies
 * to electricity in Kosovo is added separately and can be switched off.
 */
import type { Electricity } from "./types";

/** [block 1: the household's first 800 kWh of the month, block 2: everything above]. */
export const RATES = {
  /** Tariff group 6, "1-vlerësh": one price at any hour. */
  single: { high: [7.12, 12.39], low: [7.12, 12.39] },
  /** Tariff group 5, "2-vlerësh": cheaper at night. */
  dual: { high: [9.05, 15.43], low: [3.88, 7.28] },
} as const;

export const BLOCK_LIMIT_KWH = 800;
export const VAT = 0.08;
/** Charged every month whatever is used, so it is not part of what the AC costs. */
export const FIXED_MONTHLY_EUR = 2.32;

/**
 * Whether the high tariff applies at a moment, in the Mac's local time.
 * Winter (1 October to 31 March): 07:00 to 22:00. Summer: 08:00 to 23:00.
 */
export function isHighTariff(at: Date): boolean {
  const month = at.getMonth() + 1;
  const winter = month >= 10 || month <= 3;
  const hour = at.getHours();
  return winter ? hour >= 7 && hour < 22 : hour >= 8 && hour < 23;
}

/** Months (1 to 12) in which a "winter" household passes 800 kWh: October to May. */
export function isHeatingSeason(at: Date): boolean {
  const month = at.getMonth() + 1;
  return month >= 10 || month <= 5;
}

/** Which price block the unit's use falls in on a given day. */
export function blockOn(e: Electricity, at: Date): 1 | 2 {
  if (e.block === "winter") return isHeatingSeason(at) ? 2 : 1;
  return e.block;
}

/** Cents per kWh on a given day, VAT included if asked for, in the high and low periods. */
export function centsPerKwh(e: Electricity, at: Date = new Date()): { high: number; low: number } {
  const rates = RATES[e.meter];
  const i = blockOn(e, at) === 2 ? 1 : 0;
  const vat = e.vat ? 1 + VAT : 1;
  return { high: rates.high[i]! * vat, low: rates.low[i]! * vat };
}

/** What an amount of energy used on a given day costs, in euros. */
export function cost(kwhHigh: number, kwhLow: number, e: Electricity, at: Date = new Date()): number {
  const c = centsPerKwh(e, at);
  return (kwhHigh * c.high + kwhLow * c.low) / 100;
}
