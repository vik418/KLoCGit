package retry

type Policy struct {
	Attempts int
}

func RetryLimit(policy Policy) int {
	return policy.Attempts
}

func internal() int {
	return 1
}
