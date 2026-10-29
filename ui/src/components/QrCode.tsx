import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Draws a scannable QR code for `value`. The code is always dark on white, whatever the
 * theme, because phone cameras need that contrast to read it.
 */
export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((result) => {
        if (!cancelled) setSvg(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return (
      <p className="text-sm text-muted-foreground">
        The picture could not be drawn. Use the setup key below instead.
      </p>
    );
  }

  return (
    <div
      role="img"
      aria-label={label}
      data-testid="qr-code"
      className="shrink-0 overflow-hidden rounded-md border border-border bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
      style={{ width: size, height: size }}
      // The SVG comes from our own QR library, built from a value the server just made.
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
