import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { failureDetail } from "./failure-detail.ts";

type State = {
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessageCount: number;
  sessionFile?: string;
};
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const MAX_RPC_LINE_CHARS = 16 * 1024 * 1024;

function causedFailure(message: string, cause: unknown): Error {
  const detail = failureDetail(cause);
  return new Error(`${message}${detail ? `: ${detail}` : ""}`, { cause });
}

/** One isolated Pi runtime. Only one prompt may own its event stream at a time. */
export class RpcWorker {
  private proc: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private listener?: (event: any) => void;
  private failure?: (error: Error) => void;
  private closing = false;
  private prompting = false;
  private exited = false;
  private firstFailure?: Error;
  private stderrTail = "";
  private killTimer?: ReturnType<typeof setTimeout>;
  private outputEndTimer?: ReturnType<typeof setTimeout>;
  private shutdownId?: string;
  readonly closed: Promise<void>;
  readonly ready: Promise<State>;
  sessionFile?: string;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    cleanup: () => Promise<void>,
    private readonly timeoutMs = 30_000,
    private readonly settleTimeoutMs = 5 * 60_000,
  ) {
    this.proc = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let fragments: string[] = [];
    let fragmentChars = 0;
    const decoder = new StringDecoder("utf8");
    const consume = (line: string) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (
        !event ||
        typeof event !== "object" ||
        Array.isArray(event) ||
        typeof event.type !== "string"
      )
        return;
      // Closing still needs the abort reply before sending EOF. Ignore late
      // task events without discarding the shutdown handshake.
      if (
        this.closing &&
        !(event.type === "response" && this.shutdownId && event.id === this.shutdownId)
      )
        return;
      if (event.type === "response") {
        if (this.shutdownId && event.id === this.shutdownId) {
          try {
            this.proc.stdin.end();
          } catch {
            this.forceClose();
          }
          return;
        }
        const pending = this.pending.get(event.id);
        if (!pending) return;
        this.pending.delete(event.id);
        clearTimeout(pending.timer);
        // RPC errors may contain credentials; retain a bounded, redacted cause.
        if (event.success) pending.resolve(event.data);
        else {
          const detail = failureDetail(event.error ?? event.data?.error);
          pending.reject(
            new Error(`Specialist RPC ${event.command} failed${detail ? `: ${detail}` : ""}`),
          );
        }
      } else if (
        event.type === "extension_ui_request" &&
        ["select", "confirm", "input", "editor"].includes(event.method)
      ) {
        this.fail(
          new Error(
            "Specialist requires interactive input; resolve it in the parent before retrying",
          ),
        );
        void this.stop();
      } else {
        try {
          this.listener?.(event);
        } catch (err) {
          this.fail(causedFailure("Failed to process specialist events", err));
          void this.stop();
        }
      }
    };
    const feed = (text: string) => {
      if (this.proc.stdout.destroyed) return;
      const overflow = () => {
        fragments = [];
        fragmentChars = 0;
        this.fail(new Error("Specialist RPC output exceeded the line limit"));
        this.forceClose();
      };
      let start = 0;
      let end: number;
      while ((end = text.indexOf("\n", start)) !== -1) {
        const part = text.slice(start, end);
        if (fragmentChars + part.length > MAX_RPC_LINE_CHARS) {
          overflow();
          return;
        }
        if (fragments.length) fragments.push(part);
        const line = fragments.length ? fragments.join("") : part;
        fragments = [];
        fragmentChars = 0;
        consume(line);
        if (this.proc.stdout.destroyed) return;
        start = end + 1;
      }
      if (start < text.length) {
        const part = text.slice(start);
        if (fragmentChars + part.length > MAX_RPC_LINE_CHARS) {
          overflow();
          return;
        }
        fragments.push(part);
        fragmentChars += part.length;
      }
    };
    this.proc.stdout.on("data", (chunk: Buffer) => feed(decoder.write(chunk)));
    this.proc.stdout.on("end", () => {
      // stdout can end just before a normal child exit. Give that close event
      // one short chance to classify the exit before treating it as a pipe loss.
      if (this.closing || this.exited) return;
      this.outputEndTimer = setTimeout(() => {
        this.outputEndTimer = undefined;
        if (
          this.closing ||
          this.exited ||
          this.proc.exitCode !== null ||
          this.proc.signalCode !== null
        )
          return;
        this.fail(new Error("Specialist RPC output closed"));
        this.forceClose();
      }, 100);
      this.outputEndTimer.unref?.();
    });
    this.proc.stdout.on("error", (err: Error) => {
      this.fail(causedFailure("Specialist RPC output failed", err));
      this.forceClose();
    });
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    this.proc.stderr.on("error", () => {});
    this.proc.stderr.resume();
    this.proc.stdin.on("error", (err: Error) => {
      this.fail(causedFailure("Specialist RPC input failed", err));
      this.forceClose();
    });
    this.proc.on("error", (err: Error) => this.fail(causedFailure("Failed to launch specialist process", err)));
    this.closed = new Promise<void>((resolve) => {
      this.proc.on("close", () => {
        this.exited = true;
        if (this.killTimer) clearTimeout(this.killTimer);
        if (this.outputEndTimer) clearTimeout(this.outputEndTimer);
        feed(decoder.end());
        // JSONL messages require a newline; a final fragment was not committed.
        fragments = [];
        const status = this.proc.signalCode
          ? `signal ${this.proc.signalCode}`
          : `exit code ${this.proc.exitCode ?? "unknown"}`;
        const stderr = failureDetail(this.stderrTail);
        const cause = this.firstFailure ? `; cause: ${failureDetail(this.firstFailure)}` : "";
        this.fail(new Error(`Specialist process closed before settlement (${status})${cause}${stderr ? `; stderr: ${stderr}` : ""}`));
        void cleanup()
          .catch(() => {})
          .finally(resolve);
      });
    });
    this.ready = this.readState().then((state) => {
      this.sessionFile = state.sessionFile;
      return state;
    });
    // A cancelled launch may close before the caller starts awaiting readiness.
    void this.ready.catch(() => {
      void this.stop();
    });
  }

  get alive(): boolean {
    return !this.closing && !this.exited;
  }

  private fail(error: Error): void {
    this.firstFailure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.failure?.(error);
  }

  private forceClose(): void {
    if (this.exited) return;
    this.closing = true;
    this.proc.kill("SIGKILL");
    // On Windows, child close can wait for stream handles after a pipe failure.
    this.proc.stdin.destroy();
    this.proc.stdout.destroy();
    this.proc.stderr.destroy();
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
      try {
        this.proc.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
      } catch (err) {
        // A synchronous pipe failure must not leave this request and its timer pending.
        this.fail(causedFailure("Specialist RPC input write failed", err));
        void this.stop();
      }
    });
  }

  private async readState(): Promise<State> {
    const state = await this.request("get_state");
    // Missing fields are not proof of idleness. Validate before accepting a
    // completed run or retaining a process for another task.
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      typeof state.isStreaming !== "boolean" ||
      typeof state.isCompacting !== "boolean" ||
      !Number.isSafeInteger(state.pendingMessageCount) ||
      state.pendingMessageCount < 0 ||
      (state.sessionFile !== undefined && typeof state.sessionFile !== "string")
    ) {
      throw new Error("Specialist RPC returned invalid state");
    }
    return state;
  }

  async prompt(
    message: string,
    signal: AbortSignal | undefined,
    onEvent: (event: any) => void,
  ): Promise<void> {
    if (this.prompting) throw new Error("Specialist already has active work");
    this.prompting = true;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let stateTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      this.fail(new Error("Specialist cancelled"));
      void this.stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) {
        onAbort();
        throw new Error("Specialist cancelled");
      }
      await this.ready;
      await new Promise<void>((resolve, reject) => {
        let accepted = false;
        let started = false;
        let settled = false;
        let checking = false;
        let revision = 0;
        let stateDelayMs = 100;
        const check = () => {
          if (!accepted || !started || !settled || checking) return;
          if (stateTimer) {
            clearTimeout(stateTimer);
            stateTimer = undefined;
          }
          checking = true;
          const observed = revision;
          void this.readState()
            .then((state) => {
              checking = false;
              this.sessionFile = state.sessionFile;
              if (observed !== revision) {
                check();
                return;
              }
              if (
                settled &&
                !state.isStreaming &&
                !state.isCompacting &&
                !state.pendingMessageCount
              )
                resolve();
              else if (settled && !stateTimer) {
                // The settle event can race a new queued action or compaction.
                // Recheck without requiring a second settle event, backing off
                // while a longer compaction is still active.
                stateTimer = setTimeout(() => {
                  stateTimer = undefined;
                  check();
                }, stateDelayMs);
                stateTimer.unref?.();
                stateDelayMs = Math.min(stateDelayMs * 2, 1000);
              }
            })
            .catch(reject);
        };
        this.failure = reject;
        this.listener = (event) => {
          onEvent(event);
          if (
            event.type === "agent_start" ||
            event.type === "message_start" ||
            event.type === "message_update" ||
            event.type === "message_end"
          ) {
            started = true;
            if (startTimer) clearTimeout(startTimer);
          }
          if (event.type === "agent_start") {
            revision++;
            settled = false;
            if (settleTimer) {
              clearTimeout(settleTimer);
              settleTimer = undefined;
            }
          }
          if (event.type === "agent_settled") {
            revision++;
            settled = true;
            stateDelayMs = 100;
            // A responsive but permanently busy get_state must not hold the
            // parent task forever. Normal model work has no such deadline.
            settleTimer ??= setTimeout(
              () => reject(new Error("Specialist did not become idle after settlement")),
              this.settleTimeoutMs,
            );
            check();
          }
        };
        void this.request("prompt", { message }).then(() => {
          accepted = true;
          if (!started)
            startTimer = setTimeout(
              () => reject(new Error("Specialist prompt did not start an agent run")),
              this.timeoutMs,
            );
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
      if (stateTimer) clearTimeout(stateTimer);
      if (settleTimer) clearTimeout(settleTimer);
      this.listener = undefined;
      this.failure = undefined;
      this.prompting = false;
    }
  }

  stop(): Promise<void> {
    if (!this.closing && !this.exited) {
      this.closing = true;
      if (this.outputEndTimer) clearTimeout(this.outputEndTimer);
      this.outputEndTimer = undefined;
      this.fail(new Error("Specialist process stopped"));
      // Abort settles tools and persists partial work before EOF disposes extensions.
      this.shutdownId = randomUUID();
      this.killTimer = setTimeout(() => this.forceClose(), 1000);
      this.killTimer.unref?.();
      try {
        this.proc.stdin.write(JSON.stringify({ id: this.shutdownId, type: "abort" }) + "\n");
      } catch {
        this.forceClose();
      }
    }
    return this.closed;
  }
}
