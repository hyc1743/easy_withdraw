import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("sell UI refreshes balance after starting a sell task and during sell-task polling", () => {
  const html = fs.readFileSync("public/index.html", "utf8");

  assert.match(
    html,
    /async function startSellTask\(\)[\s\S]*await loadSellBalance\(\)/,
  );
  assert.match(
    html,
    /function renderScheduleJob\(job\)[\s\S]*if \(isSell\) \{[\s\S]*void loadSellBalance\(\);[\s\S]*\}/,
  );
});
