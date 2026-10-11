pub mod nested;

pub fn from_module(value: usize) -> usize {
    nested::increment(value)
}
