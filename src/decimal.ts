import Decimal from "decimal.js";

// XRPL issued amounts support up to 16 significant digits. Keep extra precision for
// ratios and realized P&L, with stable serialized decimal strings at each event boundary.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -100, toExpPos: 100 });

export { Decimal };
