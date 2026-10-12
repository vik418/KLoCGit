package checks

import (
	retry "example.org/klocgit-fixture"
	"testing"
)

func TestRetryLimit(t *testing.T) {
	if retry.Retries() != 1 {
		t.Fatal("unexpected retry limit")
	}
}
