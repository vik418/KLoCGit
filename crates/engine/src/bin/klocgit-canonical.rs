use klocgit_engine::canonical;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read};

const MAX_INPUT: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Projection { domain: String, projection: Value },
    Payload { payload_hex: String },
}

#[derive(Serialize)]
struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    cbor_hex: Option<String>,
    projection_digest: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(value: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid hexadecimal payload".into());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair)?;
            Ok(u8::from_str_radix(text, 16)?)
        })
        .collect()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    io::stdin()
        .take(MAX_INPUT as u64 + 1)
        .read_to_end(&mut input)?;
    if input.len() > MAX_INPUT {
        return Err("input limit exceeded".into());
    }
    let requests: Vec<Request> = serde_json::from_slice(&input)?;
    let responses: Result<Vec<_>, Box<dyn std::error::Error>> = requests
        .into_iter()
        .map(|request| match request {
            Request::Projection { domain, projection } => Ok(Response {
                cbor_hex: Some(hex(&canonical::encode(&projection)?)),
                projection_digest: canonical::hash_projection(&domain, &projection)?,
            }),
            Request::Payload { payload_hex } => Ok(Response {
                cbor_hex: None,
                projection_digest: canonical::payload_digest(&unhex(&payload_hex)?)?,
            }),
        })
        .collect();
    println!("{}", serde_json::to_string(&responses?)?);
    Ok(())
}
