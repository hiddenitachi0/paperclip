import { useEffect, useState } from "react";
import { TRADING_ASSETS, type CreateTradingStrategyInput, type TradingAsset } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * A new strategy always starts paused (the design's hard rule -- see
 * packages/shared/src/trading.ts) and with the server's conservative default
 * rule/risk config; this dialog only collects the name, asset and starting
 * paper cash. Changing the rule or risk numbers is a `PATCH` the operator can
 * ask an engineer for later -- not exposed here, to keep a first strategy's
 * setup to three plain questions.
 */
export function CreateTradingStrategyDialog({
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onSubmit: (input: Partial<CreateTradingStrategyInput>) => void;
}) {
  const [name, setName] = useState("");
  const [asset, setAsset] = useState<TradingAsset>("BTC");
  const [startingCashNok, setStartingCashNok] = useState("3000");

  useEffect(() => {
    if (open) {
      setName("");
      setAsset("BTC");
      setStartingCashNok("3000");
    }
  }, [open]);

  const cashValue = Number(startingCashNok);
  const canSubmit = name.trim().length > 0 && Number.isFinite(cashValue) && cashValue > 0;

  function submit() {
    if (!canSubmit) return;
    onSubmit({ name: name.trim(), asset, startingCashNok: Math.round(cashValue) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a trading strategy</DialogTitle>
          <DialogDescription>
            It starts paused, trading with play money only. Nothing happens until you press "Start" on it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. BTC trend follower" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Asset</Label>
            <Select value={asset} onValueChange={(value) => setAsset(value as TradingAsset)} disabled={busy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRADING_ASSETS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Starting play money (NOK)</Label>
            <Input
              type="number"
              min={1}
              value={startingCashNok}
              onChange={(e) => setStartingCashNok(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">No real money is ever involved — this is paper trading only.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || busy}>
            Add strategy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
