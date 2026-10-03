use crate::{Frame, KIND_INPUT, KIND_JSON, KIND_OUTPUT, MAX_FRAME_LEN, Message};

#[derive(Debug, thiserror::Error)]
pub enum ProtoError {
    #[error("frame of {0} bytes exceeds the maximum")]
    TooLarge(usize),
    #[error("unknown frame kind {0}")]
    UnknownKind(u8),
    #[error("truncated frame")]
    Truncated,
    #[error("invalid JSON message: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Serialises a frame into a fresh buffer.
pub fn encode_frame(frame: &Frame) -> Vec<u8> {
    let mut out = Vec::new();
    encode_into(frame, &mut out);
    out
}

pub(crate) fn encode_into(frame: &Frame, out: &mut Vec<u8>) {
    match frame {
        Frame::Json(message) => {
            let body = serde_json::to_vec(message).expect("messages always serialise");
            out.extend_from_slice(&((body.len() + 1) as u32).to_be_bytes());
            out.push(KIND_JSON);
            out.extend_from_slice(&body);
        }
        Frame::Output { terminal, data } | Frame::Input { terminal, data } => {
            let kind = if matches!(frame, Frame::Output { .. }) {
                KIND_OUTPUT
            } else {
                KIND_INPUT
            };
            out.extend_from_slice(&((data.len() + 5) as u32).to_be_bytes());
            out.push(kind);
            out.extend_from_slice(&terminal.to_be_bytes());
            out.extend_from_slice(data);
        }
    }
}

fn decode_body(kind: u8, body: &[u8]) -> Result<Frame, ProtoError> {
    match kind {
        KIND_JSON => Ok(Frame::Json(serde_json::from_slice::<Message>(body)?)),
        KIND_OUTPUT | KIND_INPUT => {
            if body.len() < 4 {
                return Err(ProtoError::Truncated);
            }
            let terminal = u32::from_be_bytes(body[..4].try_into().unwrap());
            let data = body[4..].to_vec();
            Ok(if kind == KIND_OUTPUT {
                Frame::Output { terminal, data }
            } else {
                Frame::Input { terminal, data }
            })
        }
        other => Err(ProtoError::UnknownKind(other)),
    }
}

/// Incremental decoder: push bytes as they arrive, pull complete frames.
/// It does no I/O, so the same code serves sockets, SSH pipes and tests.
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Returns the next complete frame, `Ok(None)` if more bytes are needed.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, ProtoError> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes(self.buf[..4].try_into().unwrap()) as usize;
        if len > MAX_FRAME_LEN {
            return Err(ProtoError::TooLarge(len));
        }
        if len == 0 {
            return Err(ProtoError::Truncated);
        }
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        let kind = self.buf[4];
        let frame = decode_body(kind, &self.buf[5..4 + len]);
        self.buf.drain(..4 + len);
        frame.map(Some)
    }
}

#[cfg(feature = "tokio")]
pub async fn read_frame<R>(reader: &mut R) -> Result<Option<Frame>, ProtoError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME_LEN {
        return Err(ProtoError::TooLarge(len));
    }
    if len == 0 {
        return Err(ProtoError::Truncated);
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    decode_body(body[0], &body[1..]).map(Some)
}

#[cfg(feature = "tokio")]
pub async fn write_frame<W>(writer: &mut W, frame: &Frame) -> Result<(), ProtoError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    writer.write_all(&encode_frame(frame)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Vec<Frame> {
        vec![
            Frame::Json(Message::Request {
                id: 7,
                method: "terminal.list".into(),
                params: json!({}),
            }),
            Frame::Output {
                terminal: 3,
                data: b"\x1b[31mhello\x1b[0m".to_vec(),
            },
            Frame::Input {
                terminal: u32::MAX,
                data: vec![],
            },
            Frame::Json(Message::Event {
                name: "terminal.exited".into(),
                data: json!({"id": 3}),
            }),
        ]
    }

    #[test]
    fn round_trips_through_byte_at_a_time_decoder() {
        let bytes: Vec<u8> = sample().iter().flat_map(encode_frame).collect();
        let mut decoder = FrameDecoder::new();
        let mut out = Vec::new();
        for b in bytes {
            decoder.push(&[b]);
            while let Some(f) = decoder.next_frame().unwrap() {
                out.push(f);
            }
        }
        assert_eq!(out, sample());
    }

    #[test]
    fn rejects_oversized_frames() {
        let mut decoder = FrameDecoder::new();
        decoder.push(&((MAX_FRAME_LEN as u32) + 1).to_be_bytes());
        assert!(matches!(decoder.next_frame(), Err(ProtoError::TooLarge(_))));
    }

    #[test]
    fn rejects_unknown_kind() {
        let mut decoder = FrameDecoder::new();
        decoder.push(&[0, 0, 0, 1, 99]);
        assert!(matches!(
            decoder.next_frame(),
            Err(ProtoError::UnknownKind(99))
        ));
    }

    #[tokio::test]
    async fn async_read_write_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(64);
        let frames = sample();
        let send = frames.clone();
        let writer = tokio::spawn(async move {
            for f in &send {
                write_frame(&mut a, f).await.unwrap();
            }
        });
        let mut got = Vec::new();
        for _ in 0..frames.len() {
            got.push(read_frame(&mut b).await.unwrap().unwrap());
        }
        writer.await.unwrap();
        assert_eq!(got, frames);
    }
}
