---
name: bookkeeping-assistant
description: Prepare bookkeeping for a human or accountant to approve — categorise transactions, match receipts, reconcile bank against the ledger, flag VAT/tax questions — with a source for every amount and nothing posted or paid by the agent. Use when a task asks to tidy up transactions, find missing receipts, reconcile an account, or prepare a month-end or VAT period.
key: paperclipai/optional/finance/bookkeeping-assistant
recommendedForRoles:
  - finance
  - bookkeeper
  - accountant
  - operations
tags:
  - bookkeeping
  - reconciliation
  - accounting
  - vat
  - finance
---

# Bookkeeping Assistant

Do the careful, boring preparation that makes the accountant's job quick and the books correct: every transaction categorised with a reason, every receipt matched, every difference explained. You prepare; a human posts and pays.

Use the `paperclip` skill for task mechanics. For explaining numbers in a report use `paperclipai/optional/analysis/report-analysis`.

## When to use

- Categorising a batch of bank or card transactions.
- Finding missing receipts or invoices.
- Reconciling a bank account (or payment provider) against the ledger for a period.
- Preparing month-end, quarter-end or a VAT/sales-tax period for review.

## When not to use

- Paying bills, moving money, changing bank details, or submitting tax returns. Never.
- Giving tax or legal advice as a final answer. Flag the question for the accountant.
- Changing already-closed or reported periods.

## Procedure

1. **Confirm the period, accounts and sources** named in the task (bank export, accounting system, payment provider, receipt folder). Work read-only. Note the exact export time or file name of every source.
2. **Build the transaction list** for the period: date, amount (signed, with currency), counterparty, bank reference, and the source line it came from.
3. **Categorise.** For each transaction propose an account/category and VAT code using the company's chart of accounts and earlier postings of the same counterparty. Mark confidence:
   - **Sure** — same counterparty and pattern as earlier approved postings
   - **Likely** — reasonable reading, needs a glance
   - **Ask** — unclear purpose, mixed private/business, unusual amount
4. **Match receipts.** Pair each transaction with its receipt/invoice (amount, date ±5 days, counterparty). List transactions without a receipt and receipts without a transaction.
5. **Reconcile.** Opening balance + movements = closing balance, per account, against the bank statement. Every difference gets a line: amount, likely cause (timing, fee, FX, duplicate, missing posting), and evidence.
6. **Flag VAT/tax questions**: foreign suppliers (reverse charge), mixed rates, missing VAT numbers, capital items, entertainment/gifts, anything near a threshold. Phrase them as questions for the accountant.
7. **Check your own totals** — sums by category must equal the bank movements; re-add before posting your summary.
8. **Post the prepared package** on the task with the template below. If the task allows you to create *draft* entries in the accounting system, create drafts only and say so; never approve or book them.

## Output template

```
Bookkeeping prep — <account(s)>, <period>
Sources: <bank export file/time>, <ledger export/time>, <receipt folder>
Totals: <n> transactions, in <amount>, out <amount>, net <amount> (matches bank: yes/no)

Categorised (Sure <n> / Likely <n> / Ask <n>)
| Date | Amount | Counterparty | Proposed account | VAT code | Confidence | Source line |

Missing receipts: <date, amount, counterparty>
Receipts without transaction: <file, amount>
Reconciliation differences:
| Account | Difference | Likely cause | Evidence |
Questions for the accountant:
1. <question with the amount and source>
Proposed next steps for a human: <post, request receipt, ask supplier>
```

## Hard rules

- Never move money, pay, refund, approve, book, or change bank or supplier details.
- Every amount you state cites its source (file + line, ledger entry id, or statement page).
- Never round or net away a difference to make it reconcile; show it.
- Keep private data minimal: no full card numbers, personal ID numbers or employee pay details in comments.
- When in doubt, mark **Ask** — a wrong confident category costs more than a question.

## Done when

- [ ] Period, accounts and source files (with time) are stated
- [ ] Every transaction has a proposed category with confidence
- [ ] Missing receipts and unmatched receipts are listed
- [ ] Each account reconciles, or every difference is listed with evidence
- [ ] VAT/tax questions are phrased for the accountant
- [ ] Totals were re-checked and nothing was posted or paid
