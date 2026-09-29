import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { cardNumberErrorMessage, guessCardBrand, normalizeCardNumber } from "../lib/card-number-validation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const CURRENT_YEAR = new Date().getFullYear();
const EXPIRY_YEARS = Array.from({ length: 16 }, (_, i) => CURRENT_YEAR + i);

/**
 * Connections → "Add payment card (single-use)" (DUR-4020). Every field here
 * goes into the secret's opaque `value` (never re-displayed, same as any
 * other password-style secret); only the brand and last 4 digits — neither
 * one secret on its own — are kept in `providerMetadata` so the saved card
 * can be shown in the list afterwards.
 */
export function AddPaymentCardDialog({
  open,
  onOpenChange,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [label, setLabel] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [expMonth, setExpMonth] = useState("");
  const [expYear, setExpYear] = useState("");
  const [cvc, setCvc] = useState("");
  const [nameOnCard, setNameOnCard] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [touchedCardNumber, setTouchedCardNumber] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLabel("");
    setCardNumber("");
    setExpMonth("");
    setExpYear("");
    setCvc("");
    setNameOnCard("");
    setPostalCode("");
    setTouchedCardNumber(false);
    setError(null);
  };

  const cardError = touchedCardNumber ? cardNumberErrorMessage(cardNumber) : null;
  const digitsOnly = normalizeCardNumber(cardNumber);
  const canSubmit =
    label.trim().length > 0 &&
    cardNumberErrorMessage(cardNumber) === null &&
    /^\d{2}$/.test(expMonth) &&
    /^\d{4}$/.test(expYear) &&
    /^\d{3,4}$/.test(cvc) &&
    nameOnCard.trim().length > 0 &&
    postalCode.trim().length > 0;

  const mutation = useMutation({
    mutationFn: () =>
      secretsApi.create(companyId, {
        name: label.trim(),
        kind: "payment_card_single_use",
        value: JSON.stringify({
          cardNumber: digitsOnly,
          expMonth,
          expYear,
          cvc,
          nameOnCard: nameOnCard.trim(),
          postalCode: postalCode.trim(),
        }),
        providerMetadata: {
          brand: guessCardBrand(cardNumber),
          last4: digitsOnly.slice(-4),
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      pushToast({ title: "Card saved", tone: "success" });
      reset();
      onOpenChange(false);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not save the card");
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add payment card (single-use)</DialogTitle>
          <DialogDescription>
            This card can only be used once, then it's marked used up. Save it here so an agent can use it for one
            booking or purchase you've approved — you'll always be told what it was for.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="card-label">Label</Label>
            <Input
              id="card-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="E.g. Hotel booking card"
              maxLength={120}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="card-number">Card number</Label>
            <Input
              id="card-number"
              type="password"
              autoComplete="off"
              inputMode="numeric"
              value={cardNumber}
              onChange={(event) => setCardNumber(event.target.value)}
              onBlur={() => setTouchedCardNumber(true)}
              placeholder="1234 5678 9012 3456"
              aria-invalid={cardError !== null}
            />
            {cardError && <p className="text-xs text-destructive">{cardError}</p>}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="card-exp-month">Expiry month</Label>
              <select
                id="card-exp-month"
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
                value={expMonth}
                onChange={(event) => setExpMonth(event.target.value)}
              >
                <option value="">MM</option>
                {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map((month) => (
                  <option key={month} value={month}>
                    {month}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="card-exp-year">Expiry year</Label>
              <select
                id="card-exp-year"
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
                value={expYear}
                onChange={(event) => setExpYear(event.target.value)}
              >
                <option value="">YYYY</option>
                {EXPIRY_YEARS.map((year) => (
                  <option key={year} value={String(year)}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="card-cvc">CVC</Label>
              <Input
                id="card-cvc"
                type="password"
                autoComplete="off"
                inputMode="numeric"
                maxLength={4}
                value={cvc}
                onChange={(event) => setCvc(event.target.value.replace(/\D/g, ""))}
                placeholder="123"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="card-name">Name on card</Label>
            <Input
              id="card-name"
              value={nameOnCard}
              onChange={(event) => setNameOnCard(event.target.value)}
              placeholder="As printed on the card"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="card-postal">Billing postal code</Label>
            <Input
              id="card-postal"
              value={postalCode}
              onChange={(event) => setPostalCode(event.target.value)}
              placeholder="0150"
              maxLength={20}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            None of these details are ever shown again once saved — only the label, card brand and last 4 digits.
          </p>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save card"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
