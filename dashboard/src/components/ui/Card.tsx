import type { HTMLAttributes, ReactNode } from "react";

interface Props extends HTMLAttributes<HTMLDivElement> {
  subtle?: boolean;
  children: ReactNode;
}

export function Card({ subtle, className = "", children, ...rest }: Props) {
  return (
    <div
      {...rest}
      className={[
        "bg-bg-surface border",
        subtle ? "border-border-subtle" : "border-border",
        className,
      ].join(" ")}
    >
      {children}
    </div>
  );
}
