from api import retries


def test_retry_limit() -> None:
    """Check the public retry limit."""
    assert retries() == 1
