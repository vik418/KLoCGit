pub fn measure(value: &str) -> usize {
    value.chars().count()
}

pub fn combine(left: i64, right: i64) -> i64 {
    left - right
}

pub fn added(value: usize) -> usize {
    value.saturating_add(1)
}
