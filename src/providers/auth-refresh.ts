import { execFile } from "node:child_process";

/**
 * Conservative classifier for "credentials/token expired" errors from Bedrock
 * or the underlying AWS STS / SSO layer. Kept to a narrow allow-list so that
 * genuine errors (bad request, throttling, model-access denials) are NOT
 * mistaken for an expiry and do not trigger a refresh.
 */
export function isAuthExpiry(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  const code = (err as { code?: string })?.code ?? "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  const haystack = `${name} ${code} ${message}`;
  return (
    // STS / signed-request side: the token literally "expired".
    /ExpiredToken|ExpiredTokenException|(?:security )?token (?:included in the request )?(?:is |has )?expired|credentials? (?:have )?expired/i.test(
      haystack,
    ) ||
    // SSO-cache side: the cached session token may be reported as expired OR
    // (after `aws sso logout` / first run) "not found or is invalid" — the word
    // "expired" never appears. Match an SSO-session phrase paired with any of
    // those states, bounded so it can't run away across the whole message.
    /SSO session[\w\s=.,'"-]*?(?:has expired|not found|is invalid|invalid|expired)/i.test(
      haystack,
    ) ||
    // AWS's own remediation hint: when it tells you to re-run `aws sso login`,
    // the situation is by definition a credential refresh. Strong, version-
    // stable signal that complements the message-state matching above.
    /\baws sso login\b/i.test(haystack)
  );
}

/**
 * Parse a configured command string into argv WITHOUT a shell. Supports simple
 * single/double quoting so `--profile "my profile"` works; intentionally does
 * NOT support shell features (pipes, expansion, substitution) — the command is
 * run via execFile, not a shell, which is the trust boundary.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

export interface AuthRefreshOptions {
  /** Full command string, e.g. `aws sso login --profile my-sso-profile`. */
  command: string;
  /** Hard timeout for the spawned command (ms). */
  timeoutMs?: number;
  /** Minimum interval between refresh attempts (ms) — prevents login storms. */
  cooldownMs?: number;
}

/**
 * Runs a user-configured credential-refresh command (e.g. `aws sso login`) when
 * a provider call fails with an expired-token error. Equivalent in spirit to
 * Claude Code's `awsAuthRefresh` setting.
 *
 * Safeguards:
 *  - Single-flight: concurrent callers share one in-flight run.
 *  - Cooldown: refuses to re-run within `cooldownMs` of the last attempt.
 *  - Timeout: the spawned command is killed after `timeoutMs`.
 *  - No shell: the command is tokenized and executed via execFile, and only the
 *    configured string is ever run — no untrusted data is interpolated.
 */
export class AuthRefresh {
  private readonly argv: string[];
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private inFlight: Promise<void> | null = null;
  private lastAttemptAt: number | null = null;

  constructor(opts: AuthRefreshOptions) {
    this.argv = tokenizeCommand(opts.command);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.cooldownMs = opts.cooldownMs ?? 10_000;
  }

  /**
   * Run the refresh command. Single-flight + cooldown guarded. Resolves when the
   * command exits 0; rejects on non-zero exit, timeout, or empty command.
   */
  async run(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    const now = Date.now();
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < this.cooldownMs) {
      throw new Error(
        `auth refresh skipped: last attempt was ${now - this.lastAttemptAt}ms ago ` +
          `(cooldown ${this.cooldownMs}ms)`,
      );
    }
    this.lastAttemptAt = now;

    if (this.argv.length === 0) {
      throw new Error("auth refresh command is empty");
    }

    const [cmd, ...args] = this.argv;
    this.inFlight = new Promise<void>((resolve, reject) => {
      execFile(cmd, args, { timeout: this.timeoutMs }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    }).finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }
}
