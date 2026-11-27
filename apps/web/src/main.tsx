import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/elanor.css";
import "./styles/app.css";
import { App } from "./App.tsx";
import { applyDocumentLocale, getLocale } from "./lib/i18n.ts";
import { applyTypography, readTypographySettings } from "./lib/typography.ts";

applyTypography(readTypographySettings());
applyDocumentLocale(getLocale());

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
