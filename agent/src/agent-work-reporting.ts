export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly method: string;
  public readonly pathName: string;
  public readonly responseBody: string;

  constructor(input: { method: string; pathName: string; status: number; message: string }) {
    super(`${input.method} ${input.pathName} failed (${input.status}): ${input.message}`);
    this.name = "ApiRequestError";
    this.status = input.status;
    this.method = input.method;
    this.pathName = input.pathName;
    this.responseBody = input.message;
  }
}

export type AgentTerminalReport =
  | { kind: "complete"; result: Record<string, unknown> | null }
  | { kind: "fail"; result: Record<string, unknown> | null; errorMessage: string };

/**
 * How prepared work ended: a terminal report to send, or `released` when the control plane already
 * took the work back (it requeued it under the same lease), so there is nothing left to report.
 */
export type AgentWorkOutcome = AgentTerminalReport | { kind: "released"; reason: string };

/**
 * Runs prepare once and keeps its lease until reporting ends, including failures. prepare and
 * rejectResult supply already-sanitized reports; send must bound each request's duration.
 * Transient reports get four attempts. A lost completion reply never authorizes runtime rollback,
 * even if a later reply rejects the content. Undelivered reports are logged, not converted to /fail;
 * the control plane retains responsibility for lease expiry/reconciliation.
 */
export async function executeAndReportAgentWork(input: {
  work: { id: string; kind: string };
  prepare: () => Promise<AgentWorkOutcome>;
  send: (report: AgentTerminalReport) => Promise<void>;
  rejectResult: (error: ApiRequestError) => Promise<AgentTerminalReport>;
  stopLease: () => Promise<void>;
  redactError: (error: unknown) => string;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}): Promise<void> {
  const log = input.log ?? console.log;
  const prefix = `[nouva-agent] work ${input.work.id} (${input.work.kind})`;
  let completionMayBeCommitted = false;
  const sendWithRetry = async (report: AgentTerminalReport) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await input.send(report);
        return;
      } catch (error) {
        const transient =
          !(error instanceof ApiRequestError) ||
          error.status >= 500 ||
          error.status === 408 ||
          error.status === 429;
        if (transient && report.kind === "complete") completionMayBeCommitted = true;
        if (!transient || attempt === 3) throw error;
        await (input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          1000 * 2 ** attempt
        );
      }
    }
  };
  try {
    const outcome = await input.prepare();
    if (outcome.kind === "released") {
      log(`${prefix} returned to the queue: ${outcome.reason}`);
      return;
    }
    let report: AgentTerminalReport = outcome;
    if (report.kind === "fail") log(`${prefix} failed: ${report.errorMessage}`);
    try {
      await sendWithRetry(report);
      if (report.kind === "complete") log(`${prefix} completed`);
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.status === 422 &&
        report.kind === "complete" &&
        !completionMayBeCommitted
      ) {
        report = await input.rejectResult(error);
        if (report.kind === "fail") log(`${prefix} failed: ${report.errorMessage}`);
        await sendWithRetry(report);
      } else if (
        error instanceof ApiRequestError &&
        (error.status === 404 || error.status === 409)
      ) {
        log(`${prefix} terminal report superseded (${error.status})`);
      } else {
        log(`${prefix} ${report.kind} report failed: ${input.redactError(error)}`);
      }
    }
  } catch (error) {
    log(`${prefix} failed during execution/reporting: ${input.redactError(error)}`);
  } finally {
    await input.stopLease();
  }
}
