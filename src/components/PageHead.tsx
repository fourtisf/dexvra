import type { ReactNode } from "react";

export function PageHead({
  icon,
  title,
  sub,
  children,
}: {
  icon: string;
  title: string;
  sub?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-ic">{icon}</div>
      <h2>{title}</h2>
      {children}
      {sub && <span className="page-sub">{sub}</span>}
    </div>
  );
}
