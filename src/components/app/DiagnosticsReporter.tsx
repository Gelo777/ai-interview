import { useEffect } from "react";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import { shouldAutoReportDiagnostic, submitDiagnosticTelemetry } from "@/lib/supportReporting";

export function DiagnosticsReporter() {
  useEffect(() => {
    const reportedIds = new Set<string>();

    const unsubscribe = useDiagnosticsStore.subscribe((state) => {
      const latest = state.entries[0];
      if (!latest || reportedIds.has(latest.id) || !shouldAutoReportDiagnostic(latest)) {
        return;
      }

      reportedIds.add(latest.id);
      void submitDiagnosticTelemetry(latest);
    });

    return unsubscribe;
  }, []);

  return null;
}
