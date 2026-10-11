const CREDENTIAL_VISIBLE: bool = option_env!("KLOCGIT_CANONICAL_SECRET").is_some();

pub fn credential_visible() -> bool {
    CREDENTIAL_VISIBLE
}
