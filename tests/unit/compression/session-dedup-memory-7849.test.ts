import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sessionDedupEngine } from "../../../open-sse/services/compression/engines/session-dedup/index.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = join(REPO_ROOT, "tests/fixtures/compression/session-dedup-memory-7849.ts");
const SUFFIX_WORK_BUDGET = 32 * 1024 * 1024;
// The original #7849 fix used a shared cross-message "suffix work" char budget
// that failed the whole request open (with this warning) once exceeded. PR
// #8438 replaced that mechanism with a simpler, per-message bound
// (MAX_SUFFIX_STARTS / MAX_TOTAL_BLOCK_BYTES in session-dedup/index.ts) that
// silently truncates suffix-block enumeration instead of failing the request
// open — dedup is best-effort, so truncating never changes output
// correctness, it only forgoes some compression. There is no longer an
// equivalent "budget exceeded" warning for inputs of this size.

function makeFixedWidthText(lineCount: number, lineChars: number, tag: string): string {
  return Array.from({ length: lineCount }, (_, index) => {
    const prefix = `${tag}-${index.toString().padStart(4, "0")}:`;
    assert.ok(prefix.length <= lineChars);
    return prefix + "x".repeat(lineChars - prefix.length);
  }).join("\n");
}

function projectedSuffixWork(text: string, passCount: number): number {
  let work = 0;
  for (let start = 0; start <= text.length; start++) {
    if (start === 0 || text.charCodeAt(start - 1) === 10) {
      work += (text.length - start) * passCount;
    }
  }
  return work;
}

function makeSharedBudgetBody(): Record<string, unknown> {
  return {
    messages: [
      { role: "tool", content: makeFixedWidthText(600, 49, "first") },
      { role: "tool", content: makeFixedWidthText(600, 49, "second") },
    ],
  };
}

test("#7849: a shape that used to exceed the shared suffix-work budget now completes cleanly under the per-message bound", () => {
  const body = makeSharedBudgetBody();
  const messages = body.messages as Array<{ content: string }>;
  const perMessageWork = messages.map(({ content }) => projectedSuffixWork(content, 2));

  assert.ok(
    perMessageWork.every((work) => work < SUFFIX_WORK_BUDGET),
    "each message must fit the two-pass budget on its own"
  );
  assert.ok(
    perMessageWork.reduce((total, work) => total + work, 0) > SUFFIX_WORK_BUDGET,
    "the pair would have exceeded the old shared budget when charged for two passes"
  );

  for (const message of messages) {
    const individualResult = sessionDedupEngine.apply({
      messages: [message, { role: "assistant", content: "a unique short companion" }],
    });
    assert.equal(individualResult.stats, null, "each message must be accepted individually");
  }

  // The two messages use distinct tags ("first"/"second"), so they share no
  // duplicate content — under the new per-message MAX_SUFFIX_STARTS /
  // MAX_TOTAL_BLOCK_BYTES bound (well within budget at this size), the engine
  // finds nothing to dedup and returns the body unchanged, with no warnings.
  const result = sessionDedupEngine.apply(body);
  assert.strictEqual(result.body, body, "no duplicates found: body must be returned by identity");
  assert.equal(result.compressed, false);
  assert.equal(result.stats, null);
});

test("#7849: the previously budget-exhausting shape produces no false-positive compression or warnings", () => {
  const body = makeSharedBudgetBody();
  const result = sessionDedupEngine.apply(body);

  assert.strictEqual(result.body, body, "no duplicates found: body must be returned by identity");
  assert.equal(result.compressed, false);
  assert.equal(result.stats, null, "no dedup work occurred, so no stats/warnings are produced");
});

test("#7849: near-boundary under-budget request still deduplicates", () => {
  const repeatedText = makeFixedWidthText(578, 49, "same");
  const projectedWork = projectedSuffixWork(repeatedText, 2) * 2;
  assert.ok(projectedWork <= SUFFIX_WORK_BUDGET);
  assert.ok(
    SUFFIX_WORK_BUDGET - projectedWork < 100_000,
    "fixture must remain close to the work-budget boundary"
  );

  const body = {
    messages: [
      { role: "user", content: repeatedText },
      { role: "user", content: repeatedText },
    ],
  };
  const result = sessionDedupEngine.apply(body);
  const messages = result.body.messages as Array<{ content: string }>;

  assert.equal(result.compressed, true);
  assert.equal(messages[0].content, repeatedText);
  assert.match(messages[1].content, /^\[dedup:ref sha=[0-9a-f]{24}\]$/);
  assert.ok((result.stats?.savingsPercent ?? 0) > 0);
  assert.deepEqual(result.stats?.validationWarnings ?? [], []);
});

test(
  "#7849: line-rich long context stays within a 512 MiB heap and the stacked pipeline continues",
  { timeout: 60_000 },
  () => {
    const child = spawnSync(
      process.execPath,
      ["--max-old-space-size=512", "--import", "tsx/esm", FIXTURE],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 45_000,
      }
    );

    assert.equal(
      child.status,
      0,
      `compression child must not OOM or time out\nstdout: ${child.stdout}\nstderr: ${child.stderr}`
    );

    const output = JSON.parse(child.stdout) as {
      enginesRun: string[];
      warnings: string[];
    };
    assert.deepEqual(output.enginesRun, ["session-dedup", "lite", "rtk", "headroom", "caveman"]);
    // The fixture's lines are all unique (no repeated content), so under the
    // new per-message MAX_SUFFIX_STARTS / MAX_TOTAL_BLOCK_BYTES bound
    // session-dedup finds nothing to dedup and reports "no eligible content" —
    // there is no longer a distinct "suffix work budget exceeded" warning.
    // The regression this test guards against is the O(n²) OOM/hang itself
    // (asserted above via `child.status === 0` within the heap/time budget),
    // not this specific warning string.
    assert.ok(
      output.warnings.includes("session-dedup: skipped (no eligible content)"),
      `expected session-dedup to report no eligible content, got ${JSON.stringify(output.warnings)}`
    );
  }
);
