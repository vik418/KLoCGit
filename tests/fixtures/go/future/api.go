package retry

type Policy struct {
	Attempts int
	DelayMs  int
}

func RetryLimit(policy Policy) int {
	if policy.Attempts < 1 {
		return 1
	}
	return policy.Attempts
}

func internal() int {
	return 2
}
