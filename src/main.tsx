import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installGlobalErrorDiagnostics, logInfo } from "@/lib/diagnostics";
import { ErrorBoundary } from "@/components/app/ErrorBoundary";

installGlobalErrorDiagnostics();
logInfo("app.bootstrap", "UI bootstrap started");

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
