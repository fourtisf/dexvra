"use client";

import { useApp } from "./AppState";

export function Toast() {
  const { toastMsg } = useApp();
  return <div className={`toast ${toastMsg ? "on" : ""}`}>{toastMsg ?? ""}</div>;
}
