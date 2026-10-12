package checks

import (
	"testing"
	retry "example.org/klocgit-fixture"
)

func TestRetryLimit(t *testing.T) {
	if retry.Retries() != 1 {
		t.Fatal("unexpected retry limit")
	}
}
