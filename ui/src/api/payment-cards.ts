import type { PaymentCardSummary } from "@paperclipai/shared";
import { api } from "./client";

export interface DisablePaymentCardInput {
  reason?: string | null;
}

export interface MarkPaymentCardUsedUpInput {
  reason?: string | null;
}

export const paymentCardsApi = {
  list: (companyId: string) => api.get<PaymentCardSummary[]>(`/companies/${companyId}/payment-cards`),
  disable: (companyId: string, id: string, data: DisablePaymentCardInput = {}) =>
    api.post<PaymentCardSummary>(`/companies/${companyId}/payment-cards/${id}/disable`, data),
  markUsedUp: (companyId: string, id: string, data: MarkPaymentCardUsedUpInput = {}) =>
    api.post<PaymentCardSummary>(`/companies/${companyId}/payment-cards/${id}/mark-used-up`, data),
};
