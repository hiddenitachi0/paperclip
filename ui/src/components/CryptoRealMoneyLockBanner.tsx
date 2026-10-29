import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";

/** Shown to instance administrators while PAPERCLIP_CRYPTO_REAL_MONEY keeps real-money crypto switched off. */
export function CryptoRealMoneyLockBanner({ locked }: { locked?: boolean }) {
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    enabled: locked === true,
  });
  if (!locked || !boardAccess?.isInstanceAdmin) return null;
  return (
    <div className="flex items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground" data-testid="crypto-real-money-lock-banner">
      <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Real money is switched off on this server (administrator setting). Crypto wallets work on test networks only.</span>
    </div>
  );
}
