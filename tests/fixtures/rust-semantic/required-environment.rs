pub fn required_credential() -> &'static str {
    env!("KLOCGIT_CANONICAL_SECRET")
}
