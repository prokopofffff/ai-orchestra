import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary-red" | "primary-blue" | "primary-green" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

const variantClass: Record<Variant, string> = {
  "primary-red":
    "bg-accent-red text-text-on-accent hover:bg-accent-red/90 focus-visible:ring-accent-red/40",
  "primary-blue":
    "bg-accent-blue text-text-on-accent hover:bg-accent-blue/90 focus-visible:ring-accent-blue/40",
  "primary-green":
    "bg-accent-green text-text-on-accent hover:bg-accent-green/90 focus-visible:ring-accent-green/40",
  secondary:
    "bg-transparent text-text-secondary border border-border hover:text-text-primary hover:border-text-secondary focus-visible:ring-border",
  ghost:
    "bg-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover focus-visible:ring-border",
};

const sizeClass: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-9 px-3.5 text-xs gap-1.5",
  lg: "h-11 px-5 text-sm gap-2",
};

export function Button({
  variant = "secondary",
  size = "md",
  leadingIcon,
  trailingIcon,
  className = "",
  children,
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      className={[
        "inline-flex items-center justify-center rounded-sm font-medium transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-0",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variantClass[variant],
        sizeClass[size],
        className,
      ].join(" ")}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}
