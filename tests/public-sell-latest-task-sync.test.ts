import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("sell view sync fetches the latest completed sell task when there is no active task", () => {
  const html = fs.readFileSync("public/index.html", "utf8");

  assert.match(
    html,
    /async function syncSchedule\(\)[\s\S]*\/tasks\/latest\?job_type=sell_market/,
  );
});
