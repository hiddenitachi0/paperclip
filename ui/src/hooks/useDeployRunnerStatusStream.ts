import { useCallback, useEffect, useRef, useState } from "react";
import type { DeployRunnerStatusEntry, DeployRunnerStatusStreamEvent } from "../api/deployRunner";

/**
 * DUR-4235: live tail of GET /companies/:companyId/deploy-runner/status for
 * the UI's deploy log viewer. Same EventSource pattern as
 * ui/src/plugins/bridge.ts's usePluginStream -- withCredentials for the
 * board session cookie, close-on-unmount, reconnect by remounting (a fresh
 * `key` on the owning component, same as the plugin bridge).
 */
export function useDeployRunnerStatusStream(
  companyId: string | null | undefined,
  options?: { approvalId?: string; enabled?: boolean },
): {
  entries: DeployRunnerStatusEntry[];
  connecting: boolean;
  connected: boolean;
  error: Error | null;
} {
  const enabled = options?.enabled ?? true;
  const approvalId = options?.approvalId;
  const [entries, setEntries] = useState<DeployRunnerStatusEntry[]>([]);
  const [connecting, setConnecting] = useState(Boolean(companyId && enabled));
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setConnecting(false);
    setConnected(false);
  }, []);

  useEffect(() => {
    setEntries([]);
    setError(null);

    if (!companyId || !enabled) {
      close();
      return;
    }

    const params = new URLSearchParams();
    if (approvalId) params.set("approvalId", approvalId);
    const query = params.toString();
    const source = new EventSource(
      `/api/companies/${encodeURIComponent(companyId)}/deploy-runner/status/stream${query ? `?${query}` : ""}`,
      { withCredentials: true },
    );
    sourceRef.current = source;
    setConnecting(true);
    setConnected(false);

    source.onopen = () => {
      setConnecting(false);
      setConnected(true);
      setError(null);
    };

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as DeployRunnerStatusStreamEvent;
        if (parsed.type === "snapshot") {
          setEntries(parsed.entries);
        } else {
          setEntries((current) => [...current, ...parsed.entries]);
        }
      } catch (parseError) {
        setError(parseError instanceof Error ? parseError : new Error(String(parseError)));
      }
    };

    source.onerror = () => {
      setConnecting(false);
      setConnected(false);
      setError(new Error("Lost connection to the deploy log stream"));
    };

    return () => {
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
    };
  }, [companyId, enabled, approvalId, close]);

  return { entries, connecting, connected, error };
}
