import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installGlobalErrorDiagnostics, logInfo } from "@/lib/diagnostics";

installGlobalErrorDiagnostics();
logInfo("app.bootstrap", "UI bootstrap started");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
