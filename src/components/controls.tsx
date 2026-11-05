import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "line" }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-100 disabled:text-[var(--ui-text-1)]",
        variant === "primary" && "border-2 border-border bg-bg text-fg",
        variant === "ghost" && "border border-border bg-bg text-fg",
        variant === "line" && "border border-border bg-bg text-fg",
        className,
      )}
      {...props}
    />
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-11 w-full rounded-xl border border-border bg-bg px-3 text-base text-fg outline-none placeholder:text-muted focus-visible:outline focus-visible:outline-border",
        className,
      )}
      {...props}
    />
  );
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full rounded-xl border border-border bg-bg px-3 py-3 text-base text-fg outline-none placeholder:text-muted focus-visible:outline focus-visible:outline-border",
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-2 text-sm text-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}
