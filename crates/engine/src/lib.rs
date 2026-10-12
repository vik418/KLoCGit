pub mod canonical;
pub mod contracts;
pub mod extractors;
pub mod git;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("limit exceeded: {0}")]
    LimitExceeded(&'static str),
    #[error("composition conflict: {0}")]
    Conflict(String),
    #[error("revision does not match its immutable input")]
    RevisionMismatch,
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error(transparent)]
    Serialization(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
