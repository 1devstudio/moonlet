//! Images attached to a chat message (X29). The webview cannot read files,
//! so the app reads a picked image and hands its bytes over; the session's
//! host may be remote, where the Mac's path means nothing.

use std::path::Path;

use anyhow::{Result, bail};

/// The largest image that is sent, in bytes.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

/// The media type of an image the agents accept, by extension.
pub fn image_media_type(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Reads an image the user picked, refusing other files and large ones.
pub fn read_image(path: &str) -> Result<Vec<u8>> {
    if image_media_type(path).is_none() {
        bail!("not an image: {path}");
    }
    let size = std::fs::metadata(path)?.len();
    if size > MAX_IMAGE_BYTES {
        bail!("{} is larger than 5 MB", Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path));
    }
    Ok(std::fs::read(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_the_image_types_agents_accept() {
        assert_eq!(image_media_type("/Users/me/Desktop/Shot.PNG"), Some("image/png"));
        assert_eq!(image_media_type("photo.jpeg"), Some("image/jpeg"));
        assert_eq!(image_media_type("photo.jpg"), Some("image/jpeg"));
        assert_eq!(image_media_type("anim.gif"), Some("image/gif"));
        assert_eq!(image_media_type("a.webp"), Some("image/webp"));
        assert_eq!(image_media_type("notes.md"), None);
        assert_eq!(image_media_type("Makefile"), None);
    }

    #[test]
    fn reads_small_images_and_refuses_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("dot.png");
        std::fs::write(&png, b"\x89PNG\r\n").unwrap();
        assert_eq!(read_image(png.to_str().unwrap()).unwrap(), b"\x89PNG\r\n");

        let text = dir.path().join("secret.txt");
        std::fs::write(&text, b"token").unwrap();
        assert!(read_image(text.to_str().unwrap()).is_err());

        let big = dir.path().join("big.png");
        std::fs::File::create(&big).unwrap().set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert_eq!(read_image(big.to_str().unwrap()).unwrap_err().to_string(), "big.png is larger than 5 MB");
    }
}
