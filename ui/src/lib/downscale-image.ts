const AVATAR_DIMENSION = 256;
const SVG_CONTENT_TYPE = "image/svg+xml";

/**
 * Shrinks a raster image through a canvas to a 256×256 square before upload,
 * cropped to fill (matching the `object-cover` avatar display). SVGs are
 * passed through untouched — they're vector, so there's nothing to shrink,
 * and re-encoding through canvas would rasterize them.
 */
export function downscaleAvatarImage(file: File): Promise<File> {
  if (file.type === SVG_CONTENT_TYPE) return Promise.resolve(file);

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_DIMENSION;
      canvas.height = AVATAR_DIMENSION;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }

      const scale = Math.max(
        AVATAR_DIMENSION / image.naturalWidth,
        AVATAR_DIMENSION / image.naturalHeight,
      );
      const drawWidth = image.naturalWidth * scale;
      const drawHeight = image.naturalHeight * scale;
      const dx = (AVATAR_DIMENSION - drawWidth) / 2;
      const dy = (AVATAR_DIMENSION - drawHeight) / 2;
      ctx.drawImage(image, dx, dy, drawWidth, drawHeight);

      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Canvas encoding failed"));
          return;
        }
        const name = file.name.replace(/\.[^./\\]+$/, "") + ".png";
        resolve(new File([blob], name, { type: "image/png" }));
      }, "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Image could not be read"));
    };
    image.src = objectUrl;
  });
}
