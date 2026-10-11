pub trait Measure {
    fn measure(&self) -> usize;
}

pub struct Item {
    pub value: usize,
}

impl Measure for Item {
    fn measure(&self) -> usize {
        self.value
    }
}

pub fn generic<T: Measure>(value: &T) -> usize {
    value.measure()
}

pub fn closure(value: usize) -> usize {
    let increment = |input: usize| input + 1;
    increment(value)
}

pub fn dynamic(value: &dyn Measure) -> usize {
    value.measure()
}
