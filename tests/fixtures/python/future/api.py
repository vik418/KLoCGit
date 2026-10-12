from pydantic import BaseModel


class RetryPolicy(BaseModel):
    attempts: int
    delay_ms: int = 100


def retry_limit(policy: RetryPolicy) -> int:
    return max(1, policy.attempts)


def _internal() -> int:
    return 2
