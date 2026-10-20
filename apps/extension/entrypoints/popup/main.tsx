// Must load before @peculiar/x509 (via @weftwallet/core), whatever the import order.
import "reflect-metadata";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../assets/app.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
