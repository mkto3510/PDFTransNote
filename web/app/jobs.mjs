// PDF TransNote：翻訳のジョブの列と，保存のまとめ役（画面に依存しない部品）
// ===========================================================================
// node --test でそのまま確かめられる（tests/jobs.test.mjs）．
//
// JobQueue
//   翻訳 1 件を「ジョブ」として列に入れ，同時に動かす数を limit 以下に保って順に動かす．
//   ジョブの状態：queued（待機）→ running（翻訳中）→ done（済み）／error（失敗）／canceled（取り消し）．
//   状態や訳文が変わるたびに，ジョブの onChange と，列全体の onChange を呼ぶ．
//
// SaveScheduler
//   保存を一本にまとめる．保存中に次の保存を頼まれたら，今の保存が終わった後に 1 回だけ保存する
//   （その間に何回頼まれても 1 回）．訳が続けて届いても，ファイルへの書き込みが重ならない．

let nextId = 1;

export class JobQueue {
  /**
   * @param {object} p
   * @param {(job: Job, signal: AbortSignal, onDelta: (full: string) => void) => Promise<string>} p.run
   *        ジョブ 1 件の翻訳を行い，訳文を返す関数．
   * @param {number} [p.limit] 同時に動かす数の上限（1 以上）
   * @param {(queue: JobQueue) => void} [p.onChange] 列のどれかが変わったときに呼ぶ
   */
  constructor({ run, limit = 2, onChange } = {}) {
    this.run = run;
    this.limit = Math.max(1, Math.floor(limit) || 1);
    this.onChange = onChange;
    /** @type {Job[]} 作った順．済んだもの・取り消したものも，remove するまで残る． */
    this.jobs = [];
  }

  setLimit(limit) {
    this.limit = Math.max(1, Math.floor(limit) || 1);
    this.#pump();
  }

  /**
   * ジョブを作って列に入れる．
   * @param {object} p
   * @param {string} p.source 原文
   * @param {object} [p.meta] 呼ぶ側が自由に使う情報（ハイライト，カードなど）
   * @param {(job: Job) => void} [p.onChange] このジョブが変わったときに呼ぶ
   * @returns {Job}
   */
  add({ source, meta = {}, onChange } = {}) {
    const job = new Job(this, source, meta, onChange);
    this.jobs.push(job);
    this.#notify(job);
    this.#pump();
    return job;
  }

  /** 列から外す（動いていれば取り消す）． */
  remove(job) {
    job.cancel();
    this.jobs = this.jobs.filter((j) => j !== job);
    this.onChange?.(this);
  }

  /** 状態ごとの数． */
  counts() {
    const c = { queued: 0, running: 0, done: 0, error: 0, canceled: 0 };
    for (const j of this.jobs) c[j.status]++;
    return c;
  }

  /** まだ終わっていない（待機中か翻訳中の）ジョブがあるか． */
  get busy() {
    return this.jobs.some((j) => j.status === "queued" || j.status === "running");
  }

  #notify(job) {
    try {
      job.onChange?.(job);
    } finally {
      this.onChange?.(this);
    }
  }

  /** 空きがあれば，待機中のジョブを古い順に動かす． */
  #pump() {
    let running = this.jobs.filter((j) => j.status === "running").length;
    for (const job of this.jobs) {
      if (running >= this.limit) break;
      if (job.status !== "queued") continue;
      running++;
      this.#start(job);
    }
  }

  async #start(job) {
    const controller = new AbortController();
    job._controller = controller;
    job.status = "running";
    job.output = "";
    job.error = null;
    this.#notify(job);
    try {
      const result = await this.run(job, controller.signal, (full) => {
        if (job._controller !== controller) return; // 取り消し後に届いた分は捨てる
        job.output = full;
        this.#notify(job);
      });
      if (job._controller !== controller) return;
      job.output = result;
      job.status = "done";
    } catch (e) {
      if (job._controller !== controller) return;
      if (controller.signal.aborted || e?.name === "AbortError") job.status = "canceled";
      else {
        job.status = "error";
        job.error = e?.message ?? String(e);
      }
    } finally {
      if (job._controller === controller) {
        job._controller = null;
        this.#notify(job);
      }
      this.#pump();
    }
  }

  /** @internal Job から呼ぶ． */
  _changed(job) {
    this.#notify(job);
    this.#pump();
  }
}

export class Job {
  constructor(queue, source, meta, onChange) {
    this.id = nextId++;
    this.queue = queue;
    this.source = source;
    this.meta = meta;
    this.onChange = onChange;
    this.status = "queued";
    this.output = "";
    this.error = null;
    this._controller = null;
  }

  get finished() {
    return this.status === "done" || this.status === "error" || this.status === "canceled";
  }

  /** 取り消す（待機中なら列から外れ，翻訳中なら通信を止める）． */
  cancel() {
    if (this.finished) return;
    const c = this._controller;
    this._controller = null;
    c?.abort();
    this.status = "canceled";
    this.queue._changed(this);
  }

  /** やり直す（原文を変えてもよい）．翻訳中なら止めてから列の最後に入れ直す． */
  retry(source = this.source) {
    const c = this._controller;
    this._controller = null;
    c?.abort();
    this.source = source;
    this.status = "queued";
    this.output = "";
    this.error = null;
    // 列の最後に回す
    this.queue.jobs = this.queue.jobs.filter((j) => j !== this).concat(this);
    this.queue._changed(this);
  }
}

export class SaveScheduler {
  /**
   * @param {() => Promise<void>} save 実際に保存する関数
   */
  constructor(save) {
    this.save = save;
    this.running = null; // 動いている保存（Promise）
    this.pending = false; // 保存中に次を頼まれたか
  }

  /**
   * 保存を頼む．今の保存（と，必要ならその後の 1 回）が終わったら解決する Promise を返す．
   * 保存が失敗しても，次の依頼は受け付ける．
   */
  request() {
    if (this.running) {
      this.pending = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.pending = false;
          try {
            await this.save();
          } catch {
            // 失敗は save の側で知らせる．ここでは止まらない．
          }
        } while (this.pending);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
