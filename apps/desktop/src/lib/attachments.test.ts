import { describe, expect, it } from "vitest";
import { base64, splitAttachments } from "./attachments";

describe("attached files (X29)", () => {
  it("sends images as images and mentions everything else", () => {
    expect(splitAttachments(["/Users/me/Desktop/Shot.PNG", "/Users/me/repo/src/login.ts", "/tmp/photo.jpeg", "/tmp/notes.md"])).toEqual({
      images: [
        { path: "/Users/me/Desktop/Shot.PNG", name: "Shot.PNG", mediaType: "image/png" },
        { path: "/tmp/photo.jpeg", name: "photo.jpeg", mediaType: "image/jpeg" },
      ],
      files: ["/Users/me/repo/src/login.ts", "/tmp/notes.md"],
    });
  });

  it("knows gif and webp, and nothing without an extension", () => {
    expect(splitAttachments(["/a/anim.gif", "/a/b.webp", "/a/Makefile"]).images.map((i) => i.mediaType)).toEqual(["image/gif", "image/webp"]);
    expect(splitAttachments(["/a/Makefile"]).files).toEqual(["/a/Makefile"]);
  });

  it("encodes image bytes as base64", () => {
    // The first bytes of every PNG file.
    expect(base64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer)).toBe("iVBORw0KGgo=");
  });
});
