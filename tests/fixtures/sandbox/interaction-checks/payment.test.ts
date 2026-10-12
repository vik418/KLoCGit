import { processPayment } from "/workspace/service.ts";
import { reset, count } from "/workspace/ledger.ts";

beforeEach(() => reset());

it("charges at most once when delivery confirmation is lost", () => {
  expect(() => processPayment("payment-123")).toThrow();
  expect(count()).toBe(1);
});
