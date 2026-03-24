import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("clearing the task panel suppresses reloading the same latest task immediately", () => {
  const html = fs.readFileSync("public/index.html", "utf8");

  assert.match(html, /let _dismissedLatestTaskIds = \{/);
  assert.match(html, /function dismissLatestTask\(job\)/);
  assert.match(
    html,
    /async function syncSchedule\(\)[\s\S]*_dismissedLatestTaskIds\[latest\.job\.job_type\][\s\S]*latest\.job\.id/,
  );
});
