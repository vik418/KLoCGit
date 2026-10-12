from pydantic import BaseModel


class RetryPolicy(BaseModel):
    attempts: int


def retry_limit(policy: RetryPolicy) -> int:
    return policy.attempts


def _internal() -> int:
    return 1
