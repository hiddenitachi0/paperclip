import type { ElementType, ReactNode } from "react";
import { maskText } from "../lib/presentationMasking";
import { usePresentationMode } from "../context/PresentationModeContext";

interface PresentationMaskedProps {
  children: string | number | null | undefined;
  as?: ElementType;
  className?: string;
}

/**
 * Wraps a single piece of rendered text (a money amount, an email, a name)
 * so it's masked while presentation mode is on. Renders the original text
 * untouched when presentation mode is off — this component has no effect on
 * state, storage, or what's sent to the server; it only changes what's drawn
 * on screen (DUR-4466).
 */
export function PresentationMasked({ children, as: Component = "span", className }: PresentationMaskedProps): ReactNode {
  const { enabled, strict, keepList, extraMaskedNames } = usePresentationMode();
  const text = children == null ? "" : String(children);

  if (!enabled) {
    return <Component className={className}>{text}</Component>;
  }

  const masked = maskText(text, { strict, keepList, extraMaskedNames });
  return <Component className={className}>{masked}</Component>;
}
