//! AES helpers and packet builders for the authenticated queue stream.

use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
use aes::Aes128;

pub const STREAM_KEY: &[u8; 16] = b"Fa0b4tA25f4R038a";
pub const MEMORY_KEY: &[u8; 16] = b"Lh2yfB7n6X7d9a5Z";

/// Standard CRC-32/ISO-HDLC, matching Python's `binascii.crc32`.
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn encrypt_ecb<const N: usize>(mut bytes: [u8; N], key: &[u8; 16]) -> [u8; N] {
    assert_eq!(N % 16, 0);
    let cipher = Aes128::new(GenericArray::from_slice(key));
    for block in bytes.chunks_exact_mut(16) {
        let block = GenericArray::from_mut_slice(block);
        cipher.encrypt_block(block);
    }
    bytes
}

pub fn encrypt_stream_payload(plaintext: [u8; 32]) -> [u8; 32] {
    encrypt_ecb(plaintext, STREAM_KEY)
}

pub fn decrypt_memory_payload(ciphertext: [u8; 16]) -> [u8; 16] {
    // AES-ECB memory blocks are encrypted by the device with the same key. The
    // inverse is needed here, so use the cipher's decrypt operation explicitly.
    use aes::cipher::BlockDecrypt;
    let cipher = Aes128::new(GenericArray::from_slice(MEMORY_KEY));
    let mut block = GenericArray::clone_from_slice(&ciphertext);
    cipher.decrypt_block(&mut block);
    block.into()
}

pub fn build_memory_read(tid: u8, address: u32, size: u32) -> [u8; 36] {
    let mut plain = [0xFFu8; 32];
    plain[0..4].copy_from_slice(&address.to_le_bytes());
    plain[4..8].copy_from_slice(&size.to_le_bytes());
    plain[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    let checksum = crc32(&plain[..12]);
    plain[12..16].copy_from_slice(&checksum.to_le_bytes());
    let encrypted = encrypt_ecb(plain, MEMORY_KEY);
    let mut packet = [0u8; 36];
    packet[..4].copy_from_slice(&[0x44, tid, 0x01, 0x01]);
    packet[4..].copy_from_slice(&encrypted);
    packet
}

pub fn build_stream_auth(tid: u8, timestamp_ms: u64, hardware_id: [u8; 12]) -> [u8; 36] {
    let mut plain = [0u8; 32];
    plain[..8].copy_from_slice(&timestamp_ms.to_le_bytes());
    plain[8..20].copy_from_slice(&hardware_id);
    // The firmware accepts arbitrary padding. Zeroes make packet generation deterministic.
    let encrypted = encrypt_stream_payload(plain);
    let mut packet = [0u8; 36];
    packet[..4].copy_from_slice(&[0x4C, tid, 0x00, 0x02]);
    packet[4..].copy_from_slice(&encrypted);
    packet
}

pub fn auth_level(attribute: u16) -> u8 {
    ((attribute >> 1) & 0x03) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_standard_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn memory_request_contains_crc_and_raw_header() {
        let packet = build_memory_read(7, 0x4001_0450, 12);
        assert_eq!(&packet[..4], &[0x44, 7, 0x01, 0x01]);
        let plain = decrypt_memory_payload(packet[4..20].try_into().unwrap());
        assert_eq!(
            u32::from_le_bytes(plain[..4].try_into().unwrap()),
            0x4001_0450
        );
        assert_eq!(u32::from_le_bytes(plain[4..8].try_into().unwrap()), 12);
        assert_eq!(
            u32::from_le_bytes(plain[8..12].try_into().unwrap()),
            u32::MAX
        );
        assert_eq!(
            u32::from_le_bytes(plain[12..16].try_into().unwrap()),
            crc32(&plain[..12])
        );
    }

    #[test]
    fn auth_packet_preserves_hardware_id_after_round_trip() {
        let id = *b"071KBP\r\xff\x11\x0a\xff\xff";
        let packet = build_stream_auth(2, 123, id);
        assert_eq!(&packet[..4], &[0x4C, 2, 0x00, 0x02]);
        let cipher = Aes128::new(GenericArray::from_slice(STREAM_KEY));
        let mut decoded = [0u8; 32];
        for (dst, src) in decoded
            .chunks_exact_mut(16)
            .zip(packet[4..].chunks_exact(16))
        {
            let mut block = GenericArray::clone_from_slice(src);
            use aes::cipher::BlockDecrypt;
            cipher.decrypt_block(&mut block);
            dst.copy_from_slice(&block);
        }
        assert_eq!(&decoded[8..20], &id);
    }
}
