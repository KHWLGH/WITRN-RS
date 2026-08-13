//! The USB-PD CRC32 trailer.

/// Compute the CRC32 a PD message's trailer should carry for `payload`.
///
/// This is CRC-32/ISO-HDLC (the zlib polynomial, reflected in and out) as required by
/// the PD spec, written bit-at-a-time to mirror the Python original exactly.
pub fn crc32(payload: &[u8]) -> u32 {
    let mut state = Crc::new();
    payload.iter().for_each(|&b| state.feed(b as u32, 8));
    state.finish()
}

/// Check a PD message that ends with its own 4-byte little-endian CRC32.
///
/// Returns `false` — never an error — for a message too short to carry a trailer,
/// matching the original.
pub fn verify_crc(data: &[u8]) -> bool {
    let Some(split) = data.len().checked_sub(4).filter(|_| data.len() >= 4) else {
        return false;
    };
    let (payload, trailer) = data.split_at(split);

    let mut state = Crc::new();
    payload.iter().for_each(|&b| state.feed(b as u32, 8));
    let expected = state.finish();

    let received = u32::from_le_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]);

    // Feeding the received CRC back in must leave the standard residue.
    state.feed(received, 32);
    let residue_ok = state.crc == 0xC704_DD7B;

    expected == received && residue_ok
}

/// Left-shifting CRC register fed least-significant-bit-first.
///
/// Injecting the incoming bit into bit 0 and XORing with `0x04C11DB6` is the same
/// register as the textbook `0x04C11DB7` shift — the polynomial's low bit is folded
/// into the injection — which is why this reduces to plain CRC-32.
struct Crc {
    crc: u32,
}

impl Crc {
    const POLY: u32 = 0x04C1_1DB6;

    fn new() -> Self {
        Self { crc: 0xFFFF_FFFF }
    }

    fn feed(&mut self, value: u32, bit_len: u32) {
        for i in 0..bit_len {
            let newbit = (self.crc >> 31) ^ (value >> i) & 1;
            let shifted = self.crc << 1 | newbit;
            self.crc = shifted ^ if newbit == 1 { Self::POLY } else { 0 };
        }
    }

    /// Complement and reverse the register — the reflected output and final XOR.
    fn finish(&self) -> u32 {
        (!self.crc).reverse_bits()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_standard_crc32_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"a"), 0xE8B7_BE43);
    }

    #[test]
    fn accepts_a_message_carrying_its_own_crc() {
        let payload = [0xA1u8, 0x11, 0x2C, 0x91, 0x01, 0x08];
        let mut framed = payload.to_vec();
        framed.extend_from_slice(&crc32(&payload).to_le_bytes());
        assert!(verify_crc(&framed));
    }

    #[test]
    fn rejects_a_corrupted_message() {
        let payload = [0xA1u8, 0x11, 0x2C, 0x91, 0x01, 0x08];
        let mut framed = payload.to_vec();
        framed.extend_from_slice(&crc32(&payload).to_le_bytes());
        framed[2] ^= 0x01;
        assert!(!verify_crc(&framed));
    }

    #[test]
    fn rejects_messages_too_short_to_hold_a_trailer() {
        assert!(!verify_crc(&[]));
        assert!(!verify_crc(&[1, 2, 3]));
    }
}
