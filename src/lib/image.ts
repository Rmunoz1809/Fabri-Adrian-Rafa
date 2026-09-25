// Client-side photo downscaling. Phone photos are 3–8 MB; card details are fully
// legible at 1600px, and the smaller files fit Vercel's 4.5 MB request cap and
// make AI recognition cheaper and faster.
const MAX_SIDE = 1600;
const QUALITY = 0.85;

export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file; // e.g. HEIC on browsers that can't decode it; server will reject if unsupported
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", QUALITY));
  if (!blob) return file;
  // Keep the original only if it's already small and in a format we accept.
  const acceptable = ["image/jpeg", "image/png", "image/webp"].includes(file.type);
  if (acceptable && blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
}
