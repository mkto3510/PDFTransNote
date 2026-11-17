// web/transnote-jobs.mjs のテスト．実行：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue, SaveScheduler } from "../web/app/jobs.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 外から解決できる翻訳の偽物．started に動き始めたジョブを記録する． */
function fakeRunner() {
  const pending = new Map();
  const started = [];
  const run = (job, signal, onDelta) =>
    new Promise((resolve, reject) => {
      started.push(job.source);
      pending.set(job.source, { resolve, reject, onDelta });
      signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  const finish = async (source, text = `訳:${source}`) => {
    pending.get(source).resolve(text);
    await tick();
  };
  const fail = async (source, msg = "boom") => {
    pending.get(source).reject(new Error(msg));
    await tick();
  };
  const delta = (source, full) => pending.get(source).onDelta(full);
  return { run, started, finish, fail, delta };
}

test("JobQueue：上限を超えた分は待ち，空いたら古い順に動く", async () => {
  const r = fakeRunner();
  const q = new JobQueue({ run: r.run, limit: 2 });
  const a = q.add({ source: "a" });
  const b = q.add({ source: "b" });
  const c = q.add({ source: "c" });
  assert.deepEqual(r.started, ["a", "b"]);
  assert.equal(c.status, "queued");
  assert.deepEqual(q.counts(), { queued: 1, running: 2, done: 0, error: 0, canceled: 0 });
  assert.equal(q.busy, true);

  await r.finish("b");
  assert.equal(b.status, "done");
  assert.equal(b.output, "訳:b");
  assert.deepEqual(r.started, ["a", "b", "c"]);

  await r.finish("a");
  await r.finish("c");
  assert.equal(a.status, "done");
  assert.equal(c.status, "done");
  assert.equal(q.busy, false);
});

test("JobQueue：少しずつ届く訳文と状態の知らせ", async () => {
  const r = fakeRunner();
  let queueCalls = 0;
  const q = new JobQueue({ run: r.run, limit: 1, onChange: () => queueCalls++ });
  const seen = [];
  const job = q.add({ source: "x", onChange: (j) => seen.push(`${j.status}:${j.output}`) });
  r.delta("x", "訳");
  r.delta("x", "訳文");
  await r.finish("x", "訳文です");
  assert.deepEqual(seen, ["queued:", "running:", "running:訳", "running:訳文", "done:訳文です"]);
  assert.ok(queueCalls >= seen.length);
  assert.equal(job.output, "訳文です");
});

test("JobQueue：失敗とやり直し（原文を変えて）", async () => {
  const r = fakeRunner();
  const q = new JobQueue({ run: r.run, limit: 1 });
  const job = q.add({ source: "x" });
  await r.fail("x", "接続できません");
  assert.equal(job.status, "error");
  assert.equal(job.error, "接続できません");

  job.retry("y");
  assert.equal(job.status, "running");
  assert.equal(job.source, "y");
  await r.finish("y");
  assert.equal(job.status, "done");
  assert.equal(job.output, "訳:y");
});

test("JobQueue：取り消し（待機中・翻訳中）と，空いた枠の再利用", async () => {
  const r = fakeRunner();
  const q = new JobQueue({ run: r.run, limit: 1 });
  const a = q.add({ source: "a" });
  const b = q.add({ source: "b" });
  const c = q.add({ source: "c" });

  b.cancel(); // 待機中
  assert.equal(b.status, "canceled");
  a.cancel(); // 翻訳中 → c が動く
  await tick();
  assert.equal(a.status, "canceled");
  assert.deepEqual(r.started, ["a", "c"]);
  await r.finish("c");
  assert.equal(c.status, "done");
  assert.deepEqual(q.counts(), { queued: 0, running: 0, done: 1, error: 0, canceled: 2 });

  q.remove(a);
  q.remove(b);
  assert.deepEqual(q.jobs, [c]);
});

test("JobQueue：翻訳中のやり直しでは，古い結果を捨てる", async () => {
  const r = fakeRunner();
  const q = new JobQueue({ run: r.run, limit: 1 });
  const job = q.add({ source: "old" });
  job.retry("new");
  await tick();
  assert.deepEqual(r.started, ["old", "new"]);
  await r.finish("new");
  assert.equal(job.output, "訳:new");
  assert.equal(job.status, "done");
});

test("JobQueue：上限を後から上げると，待機中のものが動く", () => {
  const r = fakeRunner();
  const q = new JobQueue({ run: r.run, limit: 1 });
  q.add({ source: "a" });
  q.add({ source: "b" });
  q.add({ source: "c" });
  assert.deepEqual(r.started, ["a"]);
  q.setLimit(3);
  assert.deepEqual(r.started, ["a", "b", "c"]);
});

test("SaveScheduler：保存中の依頼は，終わった後の 1 回にまとめる", async () => {
  let calls = 0;
  let release;
  const save = () =>
    new Promise((r) => {
      calls++;
      release = r;
    });
  const s = new SaveScheduler(save);
  const p1 = s.request();
  const p2 = s.request();
  const p3 = s.request();
  assert.equal(calls, 1);
  release();
  await tick();
  assert.equal(calls, 2); // 保存中に頼まれた 2 回は 1 回にまとまる
  release();
  await Promise.all([p1, p2, p3]);
  assert.equal(calls, 2);

  // 終わった後の依頼は新しく保存する
  const p4 = s.request();
  assert.equal(calls, 3);
  release();
  await p4;
});

test("SaveScheduler：保存が失敗しても，次の依頼は受け付ける", async () => {
  let calls = 0;
  const s = new SaveScheduler(async () => {
    calls++;
    if (calls === 1) throw new Error("locked");
  });
  await s.request();
  await s.request();
  assert.equal(calls, 2);
});
