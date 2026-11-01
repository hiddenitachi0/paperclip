export const TRADING_DISCLAIMER = "Paper trading only. Not investment advice.";

/** The standing reminder shown on every trading screen. */
export function TradingDisclaimer() {
  return (
    <p className="text-xs text-muted-foreground" data-testid="trading-disclaimer">
      {TRADING_DISCLAIMER}
    </p>
  );
}
