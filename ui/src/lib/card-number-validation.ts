/**
 * Client-side checks for the "Add payment card (single-use)" form.
 * These are UX-only (catch typos before submit); the server is the
 * source of truth and must validate again.
 */

export function normalizeCardNumber(rawInput: string): string {
  return rawInput.replace(/[\s-]/g, "");
}

export function isLuhnValid(digitsOnly: string): boolean {
  if (!/^\d+$/.test(digitsOnly)) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = digitsOnly.length - 1; i >= 0; i -= 1) {
    let digit = Number(digitsOnly[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export function isValidCardNumber(rawInput: string): boolean {
  const digitsOnly = normalizeCardNumber(rawInput);
  if (digitsOnly.length < 13 || digitsOnly.length > 19) return false;
  return isLuhnValid(digitsOnly);
}

export function cardNumberErrorMessage(rawInput: string): string | null {
  const digitsOnly = normalizeCardNumber(rawInput);
  if (digitsOnly.length === 0) return "Enter the card number.";
  if (!/^\d+$/.test(digitsOnly)) return "Card number can only contain numbers.";
  if (digitsOnly.length < 13 || digitsOnly.length > 19) {
    return "That doesn't look like a full card number.";
  }
  if (!isLuhnValid(digitsOnly)) {
    return "That card number doesn't look right. Please check it and try again.";
  }
  return null;
}
