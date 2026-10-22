use crate::{Frame, KIND_INPUT, KIND_JSON, KIND_OUTPUT, KIND_PACK, MAX_FRAME_LEN, Message};

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

/// Serialises a frame into a fresh buffer. Frames the peer would reject
/// (over [`MAX_FRAME_LEN`]) fail here, before any byte is written.
pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, ProtoError> {
    let mut out = Vec::new();
    encode_into(frame, &mut out)?;
    Ok(out)
}

pub(crate) fn encode_into(frame: &Frame, out: &mut Vec<u8>) -> Result<(), ProtoError> {
    let check = |len: usize| {
        if len > MAX_FRAME_LEN {
            Err(ProtoError::TooLarge(len))
        } else {
            Ok(len as u32)
        }
    };
    match frame {
        Frame::Json(message) => {
            let body = serde_json::to_vec(message)?;
            out.extend_from_slice(&check(body.len() + 1)?.to_be_bytes());
            out.push(KIND_JSON);
            out.extend_from_slice(&body);
        }
        Frame::Output { terminal, data } | Frame::Input { terminal, data } => {
            let kind = if matches!(frame, Frame::Output { .. }) {
                KIND_OUTPUT
            } else {
                KIND_INPUT
            };
            out.extend_from_slice(&check(data.len() + 5)?.to_be_bytes());
            out.push(kind);
            out.extend_from_slice(&terminal.to_be_bytes());
            out.extend_from_slice(data);
        }
        Frame::Pack { transfer, data } => {
            out.extend_from_slice(&check(data.len() + 5)?.to_be_bytes());
            out.push(KIND_PACK);
            out.extend_from_slice(&transfer.to_be_bytes());
            out.extend_from_slice(data);
        }
    }
    Ok(())
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
        KIND_PACK => {
            if body.len() < 4 {
                return Err(ProtoError::Truncated);
            }
            Ok(Frame::Pack {
                transfer: u32::from_be_bytes(body[..4].try_into().unwrap()),
                data: body[4..].to_vec(),
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
    // EOF before a frame starts is a clean close; EOF inside one is not.
    let mut got = 0;
    while got < 4 {
        match reader.read(&mut len_buf[got..]).await? {
            0 if got == 0 => return Ok(None),
            0 => return Err(ProtoError::Truncated),
            n => got += n,
        }
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
    writer.write_all(&encode_frame(frame)?).await?;
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
        let bytes: Vec<u8> = sample().iter().flat_map(|f| encode_frame(f).unwrap()).collect();
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

    #[test]
    fn encoder_refuses_frames_the_peer_would_reject() {
        let big = Frame::Output {
            terminal: 1,
            data: vec![0; MAX_FRAME_LEN],
        };
        assert!(matches!(encode_frame(&big), Err(ProtoError::TooLarge(_))));
    }

    #[test]
    fn a_pack_frame_round_trips() {
        let frame = Frame::Pack {
            transfer: 9,
            data: b"PACK\0\0\0\x02".to_vec(),
        };
        let mut decoder = FrameDecoder::new();
        decoder.push(&encode_frame(&frame).unwrap());
        assert_eq!(decoder.next_frame().unwrap(), Some(frame));
    }

    #[test]
    fn a_pack_goes_in_chunks_of_one_mebibyte_and_an_empty_one_ends_it() {
        let pack: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        let frames = crate::pack_frames(4, &pack);
        let sizes: Vec<(u32, usize)> = frames
            .iter()
            .map(|f| match f {
                Frame::Pack { transfer, data } => (*transfer, data.len()),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            sizes,
            [(4, 1_048_576), (4, 1_048_576), (4, 1_048_576), (4, 0)]
        );

        let mut packs = crate::PackAssembler::default();
        for f in frames {
            let Frame::Pack { transfer, data } = f else {
                unreachable!()
            };
            assert_eq!(packs.take(4), None, "complete before its end");
            packs.push(transfer, data).unwrap();
        }
        assert_eq!(packs.take(4).as_deref(), Some(&pack[..]));
        assert_eq!(packs.take(4), None, "taken once");
    }

    fn small() -> crate::PackLimits {
        crate::PackLimits {
            max_pack: 10,
            max_buffered: 25,
            max_transfers: 3,
            keep_done: std::time::Duration::from_millis(100),
        }
    }

    #[test]
    fn the_real_limits_are_one_gibibyte_sixteen_transfers_and_a_minute() {
        let l = crate::PackLimits::default();
        assert_eq!(l.max_pack, 1_073_741_824);
        assert_eq!(l.max_buffered, 1_073_741_824);
        assert_eq!(l.max_transfers, 16);
        assert_eq!(l.keep_done, std::time::Duration::from_secs(60));
    }

    #[test]
    fn a_pack_over_its_limit_is_refused() {
        let mut packs = crate::PackAssembler::new(small());
        packs.push(1, vec![0; 6]).unwrap();
        let e = packs.push(1, vec![0; 5]).unwrap_err();
        assert_eq!(e.to_string(), "pack 1 is over 10 bytes");
        // Exactly the limit is fine.
        packs.push(2, vec![0; 10]).unwrap();
        packs.push(2, vec![]).unwrap();
        assert_eq!(packs.take(2).map(|p| p.len()), Some(10));
    }

    #[test]
    fn packs_waiting_together_may_not_pass_the_buffer_limit() {
        let mut packs = crate::PackAssembler::new(small());
        packs.push(1, vec![0; 10]).unwrap();
        packs.push(1, vec![]).unwrap();
        packs.push(2, vec![0; 10]).unwrap();
        let e = packs.push(3, vec![0; 6]).unwrap_err();
        assert_eq!(e.to_string(), "packs waiting are over 25 bytes");
        // Taking one frees its room.
        let mut packs = crate::PackAssembler::new(small());
        packs.push(1, vec![0; 10]).unwrap();
        packs.push(1, vec![]).unwrap();
        packs.push(2, vec![0; 10]).unwrap();
        packs.take(1).unwrap();
        packs.push(3, vec![0; 10]).unwrap();
    }

    #[test]
    fn only_so_many_transfers_wait_at_once() {
        let mut packs = crate::PackAssembler::new(small());
        packs.push(1, vec![1]).unwrap();
        packs.push(2, vec![1]).unwrap();
        packs.push(2, vec![]).unwrap();
        packs.push(3, vec![1]).unwrap();
        let e = packs.push(4, vec![1]).unwrap_err();
        assert_eq!(e.to_string(), "more than 3 packs are waiting");
        // More chunks of one already waiting are fine.
        packs.push(3, vec![1]).unwrap();
    }

    #[test]
    fn a_pack_nobody_takes_is_dropped_after_a_while() {
        let mut packs = crate::PackAssembler::new(small());
        packs.push(1, vec![0; 10]).unwrap();
        packs.push(1, vec![]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(150));
        packs.push(2, vec![0; 10]).unwrap();
        packs.push(2, vec![]).unwrap();
        assert_eq!(packs.take(1), None);
        assert_eq!(packs.take(2).map(|p| p.len()), Some(10));
        // Its room is free again.
        packs.push(3, vec![0; 10]).unwrap();
        packs.push(4, vec![0; 10]).unwrap();
    }

    #[test]
    fn a_pack_left_half_sent_is_dropped_after_a_while() {
        let mut packs = crate::PackAssembler::new(small());
        packs.push(1, vec![0; 10]).unwrap();
        packs.push(2, vec![0; 10]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(150));
        // Both half-sent packs went, so their room is free again.
        packs.push(3, vec![0; 10]).unwrap();
        packs.push(4, vec![0; 10]).unwrap();
        packs.push(5, vec![0; 5]).unwrap();
    }

    #[test]
    fn the_rest_of_a_pack_dropped_for_being_slow_never_passes_for_all_of_it() {
        let mut packs = crate::PackAssembler::new(small());
        packs.push(1, vec![1; 10]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(150));
        packs.take(9);
        // The rest arrives after the first part was dropped.
        packs.push(1, vec![2; 4]).unwrap();
        packs.push(1, vec![]).unwrap();
        assert_eq!(packs.take(1), None);
    }

    #[test]
    fn a_chunk_for_a_pack_already_whole_is_refused() {
        let mut packs = crate::PackAssembler::new(small());
        packs.push(1, vec![0; 4]).unwrap();
        packs.push(1, vec![]).unwrap();
        assert_eq!(packs.push(1, vec![0; 4]), Err(crate::PackError::Complete(1)));
        assert_eq!(packs.push(1, vec![]), Err(crate::PackError::Complete(1)));
        assert_eq!(packs.take(1).map(|p| p.len()), Some(4));
    }

    #[tokio::test]
    async fn eof_inside_a_header_is_an_error() {
        let mut clean: &[u8] = &[];
        assert!(read_frame(&mut clean).await.unwrap().is_none());
        let mut partial: &[u8] = &[0, 0];
        assert!(matches!(read_frame(&mut partial).await, Err(ProtoError::Truncated)));
    }
}
