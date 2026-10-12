import { execute } from "./retry";
import { charge } from "./ledger";

export function processPayment(id: string): void {
  execute(() => { charge(id); throw new Error("Delivery result is unknown"); });
}
