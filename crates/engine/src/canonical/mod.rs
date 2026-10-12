//! RFC 8949 core deterministic CBOR for the domain's integer-only schemas.
//! Hash prefix: ASCII domain, NUL, then schema version as big-endian u32.
//! Payload hashes encode raw bytes as a CBOR byte string, never a storage key.

use crate::{Error, Result};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub const SCHEMA_VERSION: u32 = 1;
const MAX_DEPTH: usize = 64;
const MAX_BYTES: usize = 8 * 1024 * 1024;

pub fn nfc(value: &str) -> String { value.nfc().collect() }

pub fn encode<T: Serialize>(projection: &T) -> Result<Vec<u8>> {
    let value = serde_json::to_value(projection)?;
    let mut output = Vec::new();
    write_value(&value, &mut output, 0)?;
    Ok(output)
}

pub fn hash_projection<T: Serialize>(domain: &str, projection: &T) -> Result<String> {
    let mut hasher = prefix(domain)?;
    hasher.update(encode(projection)?);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

pub fn payload_digest(bytes: &[u8]) -> Result<String> {
    let mut hasher = prefix("klocgit.payload")?;
    let mut header_bytes = Vec::new();
    header(2, bytes.len() as u64, &mut header_bytes);
    hasher.update(header_bytes);
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn prefix(domain: &str) -> Result<Sha256> {
    if domain.is_empty() || domain.len() > 128 || !domain.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')) {
        return Err(Error::InvalidInput("invalid hash domain".into()));
    }
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(SCHEMA_VERSION.to_be_bytes());
    Ok(hasher)
}

fn header(major: u8, value: u64, out: &mut Vec<u8>) {
    let prefix = major << 5;
    match value {
        0..=23 => out.push(prefix | value as u8),
        24..=255 => out.extend([prefix | 24, value as u8]),
        256..=65535 => { out.push(prefix | 25); out.extend((value as u16).to_be_bytes()); }
        65536..=4294967295 => { out.push(prefix | 26); out.extend((value as u32).to_be_bytes()); }
        _ => { out.push(prefix | 27); out.extend(value.to_be_bytes()); }
    }
}

fn append(out: &mut Vec<u8>, bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_BYTES.saturating_sub(out.len()) { return Err(Error::LimitExceeded("CBOR bytes")); }
    out.extend(bytes);
    Ok(())
}

fn write_value(value: &Value, out: &mut Vec<u8>, depth: usize) -> Result<()> {
    if depth > MAX_DEPTH { return Err(Error::LimitExceeded("CBOR nesting")); }
    match value {
        Value::Null => out.push(0xf6),
        Value::Bool(value) => out.push(if *value { 0xf5 } else { 0xf4 }),
        Value::Number(value) => {
            if let Some(value) = value.as_u64() {
                if value > 9_007_199_254_740_991 { return Err(Error::InvalidInput("integer exceeds shared safe range".into())); }
                header(0, value, out);
            }
            else if let Some(value) = value.as_i64() {
                if value < -9_007_199_254_740_991 { return Err(Error::InvalidInput("integer exceeds shared safe range".into())); }
                header(1, (-1i128 - value as i128) as u64, out);
            }
            else { return Err(Error::InvalidInput("floating point is outside the schema".into())); }
        }
        Value::String(value) => {
            if value.len() > MAX_BYTES { return Err(Error::LimitExceeded("CBOR string")); }
            let normalized = nfc(value);
            header(3, normalized.len() as u64, out);
            append(out, normalized.as_bytes())?;
        }
        Value::Array(values) => {
            header(4, values.len() as u64, out);
            for value in values { write_value(value, out, depth + 1)?; }
        }
        Value::Object(values) => {
            let mut entries = Vec::with_capacity(values.len());
            let mut keys = std::collections::BTreeSet::new();
            for (key, value) in values {
                if key.len() > MAX_BYTES { return Err(Error::LimitExceeded("CBOR key")); }
                let normalized = nfc(key);
                if !keys.insert(normalized.clone()) { return Err(Error::InvalidInput("NFC key collision".into())); }
                let mut encoded = Vec::new();
                header(3, normalized.len() as u64, &mut encoded);
                append(&mut encoded, normalized.as_bytes())?;
                entries.push((encoded, value));
            }
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            header(5, entries.len() as u64, out);
            for (key, value) in entries { append(out, &key)?; write_value(value, out, depth + 1)?; }
        }
    }
    if out.len() > MAX_BYTES { return Err(Error::LimitExceeded("CBOR bytes")); }
    Ok(())
}
