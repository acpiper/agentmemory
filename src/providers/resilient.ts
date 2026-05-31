import type { MemoryProvider, CircuitBreakerState } from "../types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { AuthRefresh, isAuthExpiry } from "./auth-refresh.js";

export class ResilientProvider implements MemoryProvider {
  private breaker = new CircuitBreaker();
  name: string;

  constructor(
    private inner: MemoryProvider,
    private authRefresh?: AuthRefresh,
  ) {
    this.name = `resilient(${inner.name})`;
  }

  private async call(
    fn: () => Promise<string>,
    alreadyRetried = false,
  ): Promise<string> {
    if (!this.breaker.isAllowed) {
      throw new Error("circuit_breaker_open");
    }
    try {
      const result = await fn();
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      // On an expired-credential error, run the configured refresh command and
      // retry once — BEFORE recording a breaker failure, so a recoverable
      // token expiry doesn't count toward opening the circuit.
      if (!alreadyRetried && this.authRefresh && isAuthExpiry(err)) {
        try {
          await this.authRefresh.run();
          return await this.call(fn, true);
        } catch {
          // refresh (or the retry) failed — fall through to record the
          // original failure and propagate.
        }
      }
      this.breaker.recordFailure();
      throw err;
    }
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(() => this.inner.compress(systemPrompt, userPrompt));
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(() => this.inner.summarize(systemPrompt, userPrompt));
  }

  get circuitState(): CircuitBreakerState {
    return this.breaker.getState();
  }
}
