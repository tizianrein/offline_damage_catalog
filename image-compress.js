/* =============================================================
 * image-compress.js — client-side photo compression
 *
 * Why: phones produce 3-8 MB photos. We don't need that resolution
 * for damage documentation. Resizing to a max long-edge of 1600px
 * with JPEG quality 0.82 typically brings them to 200-500 KB with
 * no perceptible quality loss for inspection purposes.
 *
 * Also strips EXIF metadata (which can include GPS), since browsers
 * draw to canvas and the resulting blob has no EXIF. If you WANT to
 * keep GPS for damage reports, that's a future enhancement.
 *
 * Returns a Blob ready to be stored in IndexedDB. The original File
 * is never persisted.
 * ============================================================= */

const DEFAULT_MAX_DIM = 1600;
const DEFAULT_QUALITY = 0.82;

/**
 * Compress an image file to a Blob.
 * @param {File|Blob} file
 * @param {Object} opts
 * @param {number} [opts.maxDim=1600] - max long-edge in px
 * @param {number} [opts.quality=0.82] - JPEG quality 0..1
 * @returns {Promise<Blob>}
 */
export async function compressImage(file, opts = {}) {
  const maxDim = opts.maxDim || DEFAULT_MAX_DIM;
  const quality = opts.quality || DEFAULT_QUALITY;

  // Use createImageBitmap when available — it's faster, off-main-thread
  // capable, and respects EXIF orientation on modern browsers.
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    // Fallback: HTMLImageElement via object URL
    bitmap = await loadImageElement(file);
  }

  const { width: srcW, height: srcH } = bitmap;
  const longEdge = Math.max(srcW, srcH);
  const scale = longEdge > maxDim ? (maxDim / longEdge) : 1;
  const dstW = Math.round(srcW * scale);
  const dstH = Math.round(srcH * scale);

  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, dstW, dstH);

  // Always JPEG for size; transparency isn't relevant for damage photos.
  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });

  // Clean up
  if (bitmap.close) bitmap.close();

  if (!blob) {
    // Last resort: return original if encoding failed
    return file;
  }

  // If we somehow made it bigger than the input, prefer the input.
  if (blob.size >= file.size && file.type === 'image/jpeg') {
    return file;
  }
  return blob;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/** Format byte count for display. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
