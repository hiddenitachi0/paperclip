import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LogOut, ShieldCheck, Smartphone, UserRoundCheck } from "lucide-react";
import type { AdminAuthCheckResult, InstanceSecuritySession } from "@paperclipai/shared";
import { instanceSecurityApi } from "@/api/instanceSecurity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, relativeTime } from "../lib/utils";

function personLabel(name: string | null, email: string | null, fallback: string) {
  if (name && email) return `${name} (${email})`;
  return name || email || fallback;
}

function describeLastCheck(check: { at: string; status: string; changes: number } | null): string {
  if (!check) return "Not checked yet. The server takes its first record shortly after it starts.";
  const when = `${relativeTime(check.at)}`;
  switch (check.status) {
    case "baseline":
      return `First record taken ${when}. Future checks compare against it.`;
    case "unchanged":
      return `Checked ${when}: nothing has changed.`;
    case "changed":
      return `Checked ${when}: ${check.changes} ${check.changes === 1 ? "change" : "changes"} found. See the Activity feed for what changed.`;
    case "tampered":
      return `Checked ${when}: the signed record had been edited outside the app. A fresh record was taken -- read the notice in the Activity feed.`;
    default:
      return `Checked ${when}.`;
  }
}

function SessionRow(props: {
  session: InstanceSecuritySession;
  pending: boolean;
  onRevoke: (session: InstanceSecuritySession) => void;
}) {
  const { session, pending, onRevoke } = props;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid="security-session-row">
      <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="font-medium">{session.device}</span>
      {session.isCurrent && (
        <Badge variant="default" className="text-[10px] px-1.5 py-0">This device</Badge>
      )}
      {session.isInstanceAdmin && (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">Admin</Badge>
      )}
      <span className="text-muted-foreground truncate">
        {personLabel(session.userName, session.userEmail, "Unknown user")}
      </span>
      <span className="text-muted-foreground tabular-nums">{session.ipAddress ?? "address unknown"}</span>
      <span className="text-muted-foreground" title={formatDateTime(session.lastSeenAt)}>
        last seen {relativeTime(session.lastSeenAt)}
      </span>
      <span className="text-muted-foreground" title={formatDateTime(session.createdAt)}>
        signed in {relativeTime(session.createdAt)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-6 px-2 text-xs"
        disabled={pending}
        onClick={() => onRevoke(session)}
      >
        {pending ? "..." : session.isCurrent ? "Sign out this device" : "Sign out"}
      </Button>
    </div>
  );
}

export function InstanceSecurity() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastManualCheck, setLastManualCheck] = useState<AdminAuthCheckResult | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Security" },
    ]);
  }, [setBreadcrumbs]);

  const overviewQuery = useQuery({
    queryKey: queryKeys.instance.security,
    queryFn: () => instanceSecurityApi.getOverview(),
    refetchInterval: 30_000,
  });

  const afterSelfSignOut = () => {
    // Our own session is gone: drop the cached session so the app shows the
    // sign-in screen instead of a wall of 401s.
    queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
  };

  const checkMutation = useMutation({
    mutationFn: () => instanceSecurityApi.checkNow(),
    onSuccess: async (result) => {
      setActionError(null);
      setLastManualCheck(result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.security });
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "The check could not run."),
  });

  const signOutEverywhereMutation = useMutation({
    mutationFn: (scope: "me" | "everyone") => instanceSecurityApi.signOutEverywhere(scope),
    onSuccess: async (result) => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.security });
      if (result.signedOutSelf) afterSelfSignOut();
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "Could not sign out."),
  });

  const revokeMutation = useMutation({
    mutationFn: (session: InstanceSecuritySession) => instanceSecurityApi.revokeSession(session.id),
    onSuccess: async (result) => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.security });
      if (result.signedOutSelf) afterSelfSignOut();
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "Could not end that session."),
  });

  const overview = overviewQuery.data;
  const busy = checkMutation.isPending || signOutEverywhereMutation.isPending || revokeMutation.isPending;

  if (overviewQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading security overview...</div>;
  }
  if (overviewQuery.error || !overview) {
    return (
      <div className="text-sm text-destructive">
        {overviewQuery.error instanceof Error ? overviewQuery.error.message : "Failed to load the security overview."}
      </div>
    );
  }

  const lastCheck = overview.lastCheck;
  const attention = lastCheck?.status === "changed" || lastCheck?.status === "tampered";

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Security</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Who can administer this server, which devices are signed in right now, and whether anyone has changed the
          admin accounts behind the app's back. Anything suspicious is also posted to every company's Activity feed.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <UserRoundCheck className="mt-0.5 h-5 w-5 text-muted-foreground" />
              <div>
                <h2 className="text-sm font-semibold">Instance admins</h2>
                <p className="text-sm text-muted-foreground">
                  These people have full access to every company on this server. Add or remove admins under Access.
                </p>
              </div>
            </div>
          </div>
          {overview.admins.length === 0 ? (
            <p className="text-sm text-muted-foreground">No instance admins are set up yet.</p>
          ) : (
            <div className="divide-y rounded-md border">
              {overview.admins.map((admin) => (
                <div key={admin.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid="security-admin-row">
                  <span className="font-medium">{personLabel(admin.name, admin.email, "Unnamed admin")}</span>
                  <span className="text-muted-foreground">
                    {admin.sessionCount === 0
                      ? "not signed in anywhere"
                      : `${admin.sessionCount} ${admin.sessionCount === 1 ? "device" : "devices"} signed in`}
                  </span>
                  {admin.lastSeenAt && (
                    <span className="text-muted-foreground" title={formatDateTime(admin.lastSeenAt)}>
                      last seen {relativeTime(admin.lastSeenAt)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 text-muted-foreground" />
              <div>
                <h2 className="text-sm font-semibold">Admin account check</h2>
                <p className="text-sm text-muted-foreground">
                  The server keeps a signed record of the admin list, each admin's sign-in email and a fingerprint of
                  their password. {overview.checkIntervalMinutes > 0
                    ? `Every ${overview.checkIntervalMinutes} minutes it compares the live accounts against that record`
                    : "On demand it compares the live accounts against that record"}
                  {" "}and reports any change that did not go through the app -- for example a password reset written
                  straight into the database.
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              disabled={busy}
              onClick={() => checkMutation.mutate()}
            >
              {checkMutation.isPending ? "Checking..." : "Check now"}
            </Button>
          </div>
          <div className={attention ? "flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400" : "text-sm text-muted-foreground"}>
            {attention && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span data-testid="security-last-check">{describeLastCheck(lastCheck)}</span>
          </div>
          {!overview.snapshotSigned && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              No auth secret is configured, so the record is not signed. Set BETTER_AUTH_SECRET so it cannot be forged.
            </p>
          )}
          {lastManualCheck && lastManualCheck.notices.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {lastManualCheck.notices.map((notice, index) => (
                <li key={index}>{notice}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <LogOut className="mt-0.5 h-5 w-5 text-muted-foreground" />
              <div>
                <h2 className="text-sm font-semibold">Signed-in devices</h2>
                <p className="text-sm text-muted-foreground">
                  Every browser that is currently signed in to this server. If you see a device or address you do not
                  recognise, sign it out -- or sign out everywhere and change your password.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("Sign out of all your devices? You will have to sign in again here too.")) return;
                  signOutEverywhereMutation.mutate("me");
                }}
              >
                Sign out everywhere
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("Sign everyone out of this server? Every person, including you, will have to sign in again.")) return;
                  signOutEverywhereMutation.mutate("everyone");
                }}
              >
                Sign everyone out
              </Button>
            </div>
          </div>
          {overview.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No browser sessions are open. (Sign-ins with an API key do not appear here.)
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {overview.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  pending={revokeMutation.isPending && revokeMutation.variables?.id === session.id}
                  onRevoke={(target) => {
                    if (target.isCurrent && !window.confirm("Sign out this device? You will have to sign in again.")) return;
                    revokeMutation.mutate(target);
                  }}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
