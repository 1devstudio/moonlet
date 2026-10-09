// Files attached from the chat input's + menu (X29): images go to the agent
// as images, other files as @mentions.

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export interface PickedImage {
  path: string;
  name: string;
  mediaType: string;
}

/** An image ready to send, as `chat.send` takes it. */
export interface ChatImage {
  name: string;
  media_type: string;
  data: string;
}

export function splitAttachments(paths: string[]): { images: PickedImage[]; files: string[] } {
  const images: PickedImage[] = [];
  const files: string[] = [];
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    const mediaType = dot > 0 ? IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
    if (mediaType) images.push({ path, name, mediaType });
    else files.push(path);
  }
  return { images, files };
}

export function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let bin = "";
  // In chunks: String.fromCharCode takes its bytes as arguments.
  for (let i = 0; i < view.length; i += 0x8000) bin += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(bin);
}
