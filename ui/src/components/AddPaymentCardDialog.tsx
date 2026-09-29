import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, CreditCard } from "lucide-react";
import { cardNumberErrorMessage, normalizeCardNumber } from "../lib/card-number-validation";
import { secretsApi } from "../api/secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AddPaymentCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}

const CURRENT_YEAR = new Date().getFullYear();

/**
 * "Add payment card (single-use)" — a card an agent with "Book and buy"
 * browser access may spend from, one purchase at a time, via the browser
 * worker. Stored as an ordinary company secret (kind `payment_card_single_use`),
 * with the card details packed into the secret's one encrypted value field —
 * that field is already redacted from logs and never sent back to the
 * browser, so nothing new was needed on the server for this step. See
 * DUR-4015 for the fuller design (dedicated card table, spend caps, etc. come
 * later; this step is just capturing and storing the details safely).
 *
 * The card number, expiry and security code are never shown again once
 * saved — only the label and last 4 digits appear in Connections afterwards.
 */
export function AddPaymentCardDialog({ open, onOpenChange, companyId }: AddPaymentCardDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [label, setLabel] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [expMonth, setExpMonth] = useState("");
  const [expYear, setExpYear] = useState("");
  const [cvc, setCvc] = useState("");
  const [nameOnCard, setNameOnCard] = useState("");
  const [billingAddress, setBillingAddress] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cardError = touched ? cardNumberErrorMessage(cardNumber) : null;
  const monthNum = Number(expMonth);
  const yearNum = Number(expYear);
  const monthValid = Number.isInteger(monthNum) && monthNum >= 1 && monthNum <= 12;
  const yearValid = Number.isInteger(yearNum) && yearNum >= CURRENT_YEAR && yearNum <= CURRENT_YEAR + 20;
  const cvcValid = /^\d{3,4}$/.test(cvc);

  const canSubmit =
    label.trim().length > 0 &&
    cardNumberErrorMessage(cardNumber) === null &&
    monthValid &&
    yearValid &&
    cvcValid &&
    nameOnCard.trim().length > 0;

  function reset() {
    setLabel("");
    setCardNumber("");
    setExpMonth("");
    setExpYear("");
    setCvc("");
    setNameOnCard("");
    setBillingAddress("");
    setTouched(false);
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () => {
      const digits = normalizeCardNumber(cardNumber);
      const value = JSON.stringify({
        number: digits,
        expMonth: monthNum,
        expYear: yearNum,
        cvc,
        nameOnCard: nameOnCard.trim(),
        billing: billingAddress.trim() || null,
      });
      const last4 = digits.slice(-4);
      return secretsApi.create(companyId, {
        name: `${label.trim()} (····${last4})`,
        value,
        kind: "payment_card_single_use",
        provider: "local_encrypted",
        description: "Single-use payment card an agent with Book and buy browser access may spend from.",
      });
    },
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
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="h-4 w-4" /> Add payment card
          </DialogTitle>
          <DialogDescription>
            For a single purchase or booking at a time. Once saved, the card number, expiry and security code are
            never shown again — only the label you give it below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="card-label">Label</Label>
            <Input
              id="card-label"
              placeholder="e.g. Booking card"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              What you'll recognize it by later — this is the only thing shown again after saving.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="card-number">Card number</Label>
            <Input
              id="card-number"
              inputMode="numeric"
              autoComplete="off"
              placeholder="4242 4242 4242 4242"
              value={cardNumber}
              onChange={(e) => setCardNumber(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={cardError !== null}
            />
            {cardError && <p className="text-xs text-destructive">{cardError}</p>}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="card-exp-month">Expiry month</Label>
              <Input
                id="card-exp-month"
                inputMode="numeric"
                placeholder="MM"
                maxLength={2}
                value={expMonth}
                onChange={(e) => setExpMonth(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="card-exp-year">Expiry year</Label>
              <Input
                id="card-exp-year"
                inputMode="numeric"
                placeholder="YYYY"
                maxLength={4}
                value={expYear}
                onChange={(e) => setExpYear(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="card-cvc">Security code</Label>
              <Input
                id="card-cvc"
                inputMode="numeric"
                autoComplete="off"
                placeholder="123"
                maxLength={4}
                value={cvc}
                onChange={(e) => setCvc(e.target.value.replace(/\D/g, ""))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="card-name">Name on card</Label>
            <Input
              id="card-name"
              placeholder="As printed on the card"
              value={nameOnCard}
              onChange={(e) => setNameOnCard(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="card-billing">Billing address (optional)</Label>
            <Textarea
              id="card-billing"
              rows={2}
              placeholder="Street, postcode, city, country"
              value={billingAddress}
              onChange={(e) => setBillingAddress(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
            {mutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Save card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
