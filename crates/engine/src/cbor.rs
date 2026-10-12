//! RFC 8949 Deterministic CBOR serializer in pure Rust.

#[derive(Debug, Clone, PartialEq)]
pub enum CborValue {
    Null,
    Bool(bool),
    Integer(i64),
    Text(String),
    Bytes(Vec<u8>),
    Array(Vec<CborValue>),
    Map(Vec<(String, CborValue)>),
}

pub struct CborEncoder {
    buffer: Vec<u8>,
}

impl CborEncoder {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub fn encode(value: &CborValue) -> Vec<u8> {
        let mut encoder = Self::new();
        encoder.serialize(value);
        encoder.buffer
    }

    fn write_type_and_num(&mut self, major_type: u8, num: u64) {
        let major = major_type << 5;
        if num < 24 {
            self.buffer.push(major | (num as u8));
        } else if num <= 0xff {
            self.buffer.push(major | 24);
            self.buffer.push(num as u8);
        } else if num <= 0xffff {
            self.buffer.push(major | 25);
            self.buffer.extend_from_slice(&(num as u16).to_be_bytes());
        } else if num <= 0xffff_ffff {
            self.buffer.push(major | 26);
            self.buffer.extend_from_slice(&(num as u32).to_be_bytes());
        } else {
            self.buffer.push(major | 27);
            self.buffer.extend_from_slice(&num.to_be_bytes());
        }
    }

    pub fn serialize(&mut self, val: &CborValue) {
        match val {
            CborValue::Null => {
                self.buffer.push(0xf6);
            }
            CborValue::Bool(b) => {
                self.buffer.push(if *b { 0xf5 } else { 0xf4 });
            }
            CborValue::Integer(i) => {
                if *i >= 0 {
                    self.write_type_and_num(0, *i as u64);
                } else {
                    let n = (-1 - *i) as u64;
                    self.write_type_and_num(1, n);
                }
            }
            CborValue::Text(s) => {
                let bytes = s.as_bytes();
                self.write_type_and_num(3, bytes.len() as u64);
                self.buffer.extend_from_slice(bytes);
            }
            CborValue::Bytes(b) => {
                self.write_type_and_num(2, b.len() as u64);
                self.buffer.extend_from_slice(b);
            }
            CborValue::Array(items) => {
                self.write_type_and_num(4, items.len() as u64);
                for item in items {
                    self.serialize(item);
                }
            }
            CborValue::Map(entries) => {
                // Canonical RFC 8949 deterministic sort: sort map keys lexicographically by byte value
                let mut sorted = entries.clone();
                sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));

                self.write_type_and_num(5, sorted.len() as u64);
                for (k, v) in &sorted {
                    let k_bytes = k.as_bytes();
                    self.write_type_and_num(3, k_bytes.len() as u64);
                    self.buffer.extend_from_slice(k_bytes);
                    self.serialize(v);
                }
            }
        }
    }
}

pub fn sort_strings(mut list: Vec<String>) -> Vec<String> {
    list.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    list
}
