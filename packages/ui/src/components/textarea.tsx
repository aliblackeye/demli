import * as React from "react";
import { cn } from "../lib/cn";
import { fieldClass, isInvalid } from "./input";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Shorthand for `aria-invalid`. */
  invalid?: boolean;
}

/** Multi-line text input, styled to match {@link Input} (profile bio, etc.). */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(fieldClass, "resize-none py-2.5 leading-[1.4]", className)}
      {...props}
      aria-invalid={isInvalid(invalid, props["aria-invalid"])}
    />
  ),
);
Textarea.displayName = "Textarea";
