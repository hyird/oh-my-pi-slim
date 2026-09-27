import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

type State = { isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number; sessionFile?: string };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One isolated Pi runtime. Only one prompt may own its event stream at a time. */
export class RpcWorker {
  private proc: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private listener?: (event: any) => void;
  private failure?: (error: Error) => void;
  private closing = false;
  private prompting = false;
  private exited = false;
  private killTimer?: ReturnType<typeof setTimeout>;
  private shutdownId?: string;
  readonly closed: Promise<void>;
  readonly ready: Promise<State>;
  sessionFile?: string;

  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
    cleanup: () => Promise<void>, private readonly timeoutMs = 30_000) {
    this.proc = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env });
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    const consume = (line: string) => {
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "response") {
        if (event.id === this.shutdownId) { this.proc.stdin.end(); return; }
        const pending = this.pending.get(event.id);
        if (!pending) return;
        this.pending.delete(event.id);
        clearTimeout(pending.timer);
        // Provider errors may contain credentials; never expose their raw text.
        if (event.success) pending.resolve(event.data);
        else pending.reject(new Error(`Specialist RPC ${event.command} failed`));
      } else if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
        this.fail(new Error("Specialist requires interactive input; resolve it in the parent before retrying"));
        void this.stop();
      } else {
        try { this.listener?.(event); }
        catch { this.fail(new Error("Failed to process specialist events")); void this.stop(); }
      }
    };
    this.proc.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        consume(line);
      }
    });
    this.proc.stderr.resume();
    this.proc.stdin.on("error", () => this.fail(new Error("Specialist RPC input closed")));
    this.proc.on("error", () => this.fail(new Error("Failed to launch specialist process")));
    this.closed = new Promise<void>((resolve) => {
      this.proc.on("close", () => {
        this.exited = true;
        if (this.killTimer) clearTimeout(this.killTimer);
        buffer += decoder.end();
        if (buffer) consume(buffer);
        this.fail(new Error("Specialist process closed before settlement"));
        void cleanup().catch(() => {}).finally(resolve);
      });
    });
    this.ready = this.request("get_state").then((state: State) => {
      this.sessionFile = state.sessionFile;
      return state;
    });
    // A cancelled launch may close before the caller starts awaiting readiness.
    void this.ready.catch(() => {});
  }

  get alive(): boolean { return !this.closing && !this.exited; }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.failure?.(error);
  }

  private request(type: string, fields: Record<string, unknown> = {}): Promise<any> {
    if (!this.alive) return Promise.reject(new Error("Specialist process is unavailable"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Specialist RPC ${type} timed out`));
        void this.stop();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    });
  }

  async prompt(message: string, signal: AbortSignal | undefined, onEvent: (event: any) => void): Promise<void> {
    if (this.prompting) throw new Error("Specialist already has active work");
    this.prompting = true;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => { this.fail(new Error("Specialist cancelled")); void this.stop(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) { onAbort(); throw new Error("Specialist cancelled"); }
      await this.ready;
      await new Promise<void>((resolve, reject) => {
        let accepted = false;
        let started = false;
        let settled = false;
        let checking = false;
        let revision = 0;
        const check = () => {
          if (!accepted || !started || !settled || checking) return;
          checking = true;
          const observed = revision;
          void this.request("get_state").then((state: State) => {
            checking = false;
            this.sessionFile = state.sessionFile;
            if (observed !== revision) { check(); return; }
            if (settled && !state.isStreaming && !state.isCompacting && !state.pendingMessageCount) resolve();
          }, reject);
        };
        this.failure = reject;
        this.listener = (event) => {
          onEvent(event);
          if (event.type === "agent_start" || event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
            started = true;
            if (startTimer) clearTimeout(startTimer);
          }
          if (event.type === "agent_start") { revision++; settled = false; }
          if (event.type === "agent_settled") { revision++; settled = true; check(); }
        };
        void this.request("prompt", { message }).then(() => {
          accepted = true;
          if (!started) startTimer = setTimeout(() => reject(new Error("Specialist prompt did not start an agent run")), this.timeoutMs);
          check();
        }, reject);
      });
    } catch (err) {
      // A failed/cancelled run cannot release write ownership before its process exits.
      await this.stop();
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (startTimer) clearTimeout(startTimer);
      this.listener = undefined;
      this.failure = undefined;
      this.prompting = false;
    }
  }

  stop(): Promise<void> {
    if (!this.closing && !this.exited) {
      this.closing = true;
      this.fail(new Error("Specialist process stopped"));
      // Abort settles tools and persists partial work before EOF disposes extensions.
      this.shutdownId = randomUUID();
      this.proc.stdin.write(JSON.stringify({ id: this.shutdownId, type: "abort" }) + "\n");
      this.killTimer = setTimeout(() => { this.proc.kill("SIGKILL"); }, 1000);
      this.killTimer.unref?.();
    }
    return this.closed;
  }
}
