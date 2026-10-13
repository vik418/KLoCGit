import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/auth.ts";
import type { DecisionPacket } from "../../../packages/contracts/src/views.ts";
import { decisionFixture } from "./helpers/decisions.ts";
import { scope } from "./helpers/convergence.ts";

test("real concurrent Git work becomes one persisted review choice and one CAS promotion", async (t) => {
  const f = await decisionFixture(t);
  const [packet] = await f.decisions();
  assert.equal(packet.decision.state, "REVIEWABLE");
  assert(packet.candidates.length > 1);
  for (const candidate of packet.candidates) {
    assert(
      packet.evidence.some(
        (evidence) =>
          evidence.subject_digest === candidate.candidate.candidate_digest &&
          evidence.result === "PASSED",
      ),
    );
  }
  await f.restart();
  const [recovered] = await f.decisions();
  assert.equal(
    recovered.decision.basis.basis_digest,
    packet.decision.basis.basis_digest,
  );
  const reviewKey = randomUUID();
  const first = await f.act(
    "review",
    recovered,
    recovered.candidates[0],
    f.principal,
    reviewKey,
  );
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(
    ((await first.json()) as DecisionPacket).decision.state,
    "RESOLVABLE",
  );
  const duplicate = await f.act(
    "review",
    recovered,
    recovered.candidates[0],
    f.principal,
    reviewKey,
  );
  assert.equal(duplicate.status, 200, await duplicate.clone().text());
  await f.restart();
  const operation = randomUUID();
  const selected = recovered.candidates[0];
  const promotion = await f.act(
    "promote",
    recovered,
    selected,
    f.principal,
    operation,
  );
  assert.equal(promotion.status, 200, await promotion.clone().text());
  const receipt = (await promotion.json()) as { target_oid: string };
  const remote = join(f.directory, "remote.git");
  assert.equal(
    f.git(["--git-dir", remote, "rev-parse", "refs/heads/main"]),
    receipt.target_oid,
  );
  assert.equal(
    f.git(["--git-dir", remote, "rev-parse", receipt.target_oid + "^{tree}"]),
    selected.candidate.repo_tree_oids[scope.repo_id],
  );
  assert.equal(
    f.git([
      "--git-dir",
      remote,
      "rev-list",
      "--parents",
      "-n",
      "1",
      receipt.target_oid,
    ]),
    receipt.target_oid + " " + f.base,
  );
  const before = f.prepared;
  const retry = await f.act(
    "promote",
    recovered,
    selected,
    f.principal,
    operation,
  );
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal(f.prepared, before);
  assert.equal((await f.decisions()).length, 0);
});

test("agents and a required missing semantic capability cannot authorize a candidate", async (t) => {
  const f = await decisionFixture(t, { partial: true });
  const [packet] = await f.decisions();
  const agent: Principal = {
    ...f.principal,
    actor_type: "agent",
    sub: "agent",
    capability: { id: randomUUID(), scope, budget: 10 },
  };
  assert.equal(
    (await f.act("review", packet, packet.candidates[0], agent)).status,
    403,
  );
  const review = await f.act("review", packet);
  assert.equal(review.status, 200, await review.clone().text());
  const reviewed = (await review.json()) as DecisionPacket;
  assert.equal(reviewed.decision.state, "REVIEWABLE");
  assert(
    Object.values(reviewed.blockers).every((blockers) =>
      blockers.some((item) => item.code === "CAPABILITY_REQUIRED"),
    ),
  );
  assert.equal((await f.act("promote", reviewed)).status, 422);
  assert.equal(f.prepared, 0);
});

test("an external push during native preparation rejects stale authorization", async (t) => {
  let moved = false;
  const f = await decisionFixture(t, {
    beforePrepare: (state) => {
      if (moved) return;
      moved = true;
      state.git([
        "-C",
        join(state.directory, "driver"),
        "push",
        "--force-with-lease=refs/heads/main:" + state.base,
        "origin",
        state.commits.at(-1)! + ":refs/heads/main",
      ]);
    },
  });
  const [packet] = await f.decisions();
  assert.equal((await f.act("review", packet)).status, 200);
  assert.equal((await f.act("promote", packet)).status, 409);
  assert.equal(
    f.git([
      "--git-dir",
      join(f.directory, "remote.git"),
      "rev-parse",
      "refs/heads/main",
    ]),
    f.commits.at(-1),
  );
  const [stale] = await f.decisions();
  assert.equal(stale.decision.state, "STALE");
});

test("a lost Git response recovers the exact prepared operation after restart", async (t) => {
  const f = await decisionFixture(t);
  const [packet] = await f.decisions();
  assert.equal((await f.act("review", packet)).status, 200);
  const operation = randomUUID();
  f.obscureReceipt();
  const lost = await f.act(
    "promote",
    packet,
    packet.candidates[0],
    f.principal,
    operation,
  );
  assert.equal(lost.status, 503, await lost.clone().text());
  const accepted = f.git([
    "--git-dir",
    join(f.directory, "remote.git"),
    "rev-parse",
    "refs/heads/main",
  ]);
  await f.restart();
  const before = f.prepared;
  const recovered = await f.act(
    "promote",
    packet,
    packet.candidates[0],
    f.principal,
    operation,
  );
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.equal(f.prepared, before);
  assert.equal(
    f.git([
      "--git-dir",
      join(f.directory, "remote.git"),
      "rev-parse",
      "refs/heads/main",
    ]),
    accepted,
  );
  assert.equal((await f.decisions()).length, 0);
});

test("one reviewer changing choice does not leave an eligible approval on the previous candidate", async (t) => {
  const f = await decisionFixture(t);
  const [packet] = await f.decisions();
  const [first, second] = packet.candidates;
  assert.equal((await f.act("review", packet, first)).status, 200);
  assert.equal((await f.act("review", packet, second)).status, 200);
  assert.equal((await f.act("promote", packet, first)).status, 422);
  assert.equal((await f.act("promote", packet, second)).status, 200);
});
