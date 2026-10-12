import { retries } from "/workspace/api.ts";

describe("retry API", () => {
  it("retains the declared retry limit", () => {
    expect(retries()).toBe(1);
  });
});
