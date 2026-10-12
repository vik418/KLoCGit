export function execute(action: () => void): void {
  const attempts = 1;
  for (let index = 0; index < attempts; index++) {
    try {
      action();
      return;
    } catch (error) {
      if (index === attempts - 1) throw error;
    }
  }
}
