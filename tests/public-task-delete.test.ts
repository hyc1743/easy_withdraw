import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("async function deleteScheduleTask(job)"),
  html.indexOf("async function syncSchedule()"));

function setup(confirmed = true, fail = false) {
  const calls: unknown[] = [];
  const context = vm.createContext({
    confirm: () => confirmed,
    api: async (...args: unknown[]) => {
      calls.push(args);
      if (fail) throw new Error("delete failed");
    },
    _deletedTaskIds: new Set(),
    _schCurrentJobId: "selected",
    _taskList: [{ id: "selected" }, { id: "other" }],
    dismissLatestTask: () => calls.push("dismiss"),
    clearProgressPanel: () => calls.push("clear"),
    renderArbitrageTasks: (jobs: unknown) => calls.push(jobs),
    startSchedulePolling: () => calls.push("poll"),
    syncSchedule: async () => calls.push("sync"),
    toast: (message: string) => calls.push(message),
  });
  vm.runInContext(source, context);
  return { context, calls };
}

test("deleting selected task clears its panel and refreshes remaining tasks", async () => {
  const { context, calls } = setup();
  await vm.runInContext('deleteScheduleTask({ id: "selected" })', context);
  assert.deepEqual(calls[0], ["POST", "/tasks/selected/terminate"]);
  assert.ok(calls.includes("clear"));
  assert.ok(calls.includes("sync"));
  assert.equal(context._deletedTaskIds.has("selected"), true);
});

test("deleting another task preserves current selection", async () => {
  const { context, calls } = setup();
  await vm.runInContext('deleteScheduleTask({ id: "other" })', context);
  assert.equal(calls.includes("clear"), false);
});

test("cancelled or failed deletion preserves tasks", async () => {
  const cancelled = setup(false);
  await vm.runInContext('deleteScheduleTask({ id: "selected" })', cancelled.context);
  assert.equal(cancelled.calls.length, 0);
  const failed = setup(true, true);
  await vm.runInContext('deleteScheduleTask({ id: "selected" })', failed.context);
  assert.equal(failed.context._deletedTaskIds.size, 0);
  assert.equal(failed.calls.includes("clear"), false);
  assert.ok(failed.calls.includes("delete failed"));
});

test("running panel exposes task identity, state and execution phase", () => {
  for (const id of ["prog-id", "prog-state", "prog-phase"]) {
    assert.ok(html.includes('id="' + id + '"'));
    assert.ok(html.includes("$('" + id + "').textContent ="));
  }
  assert.ok(html.includes("deleteButton.textContent = '删除'"));
});

test("multi-task monitor exposes filters, drawer, mobile navigation and phase metrics", () => {
  for (const id of ["arb-state-filter", "arb-task-search", "arb-count-all", "arb-config", "task-back", "prog-phases", "prog-metrics"]) {
    assert.ok(html.includes('id="' + id + '"'));
  }
  assert.ok(html.includes("$('arb-config').showModal()"));
  assert.ok(html.includes("$('prog-bar-track').classList.toggle('hidden', arb)"));
  assert.ok(html.includes("row.dataset.taskId === job.id"));
  assert.ok(html.includes("const selected = _taskList.find(job => job.id === _schCurrentJobId)"));
});

test("phase labels include deposit confirmation and handle unknown phases", () => {
  const phaseSource = html.slice(html.indexOf("function taskPhaseName("), html.indexOf("function renderTaskMetrics("));
  const context = vm.createContext({});
  vm.runInContext(phaseSource, context);
  assert.equal(vm.runInContext('taskPhaseName("wait_deposit_confirmed")', context), "等待充值确认");
  assert.equal(vm.runInContext('taskPhaseName("new_phase")', context), "new_phase");
  assert.equal(vm.runInContext("taskPhaseName()", context), "--");
});
