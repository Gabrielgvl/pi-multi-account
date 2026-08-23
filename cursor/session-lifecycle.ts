import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SessionContext = { sessionManager: { getSessionId(): string; getLeafId?: () => string } };

export function registerSessionLifecycleHooks(
  pi: ExtensionAPI,
  dependencies: {
    cleanupSessionState: (sessionId: string) => void;
    stopProxy: () => void;
    debug?: (event: string, data: Record<string, unknown>) => void;
  },
): void {
  const cleanupCurrentSession = (_event: unknown, ctx: SessionContext) => {
    dependencies.debug?.("session.cleanup_hook", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
    });
    dependencies.cleanupSessionState(ctx.sessionManager.getSessionId());
  };

  pi.on("session_before_switch", cleanupCurrentSession as any);
  pi.on("session_before_fork", cleanupCurrentSession as any);
  pi.on("session_before_tree", cleanupCurrentSession as any);
  pi.on("session_shutdown", ((event: unknown, ctx: SessionContext) => {
    cleanupCurrentSession(event, ctx);
    // The proxy is process-scoped. Leaving its referenced HTTP listener open after Pi's
    // shutdown makes one-shot `pi -p` delegation print the right answer and then hang forever.
    dependencies.stopProxy();
  }) as any);
}
