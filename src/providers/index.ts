import type {
  MemoryProvider,
  ProviderConfig,
  ProviderType,
  FallbackConfig,
} from "../types.js";
import { AgentSDKProvider } from "./agent-sdk.js";
import { AnthropicProvider } from "./anthropic.js";
import { BedrockProvider } from "./bedrock.js";
import { MinimaxProvider } from "./minimax.js";
import { NoopProvider } from "./noop.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { ResilientProvider } from "./resilient.js";
import { FallbackChainProvider } from "./fallback-chain.js";
import { AuthRefresh } from "./auth-refresh.js";
import { getEnvVar } from "../config.js";

export { createEmbeddingProvider, createImageEmbeddingProvider } from "./embedding/index.js";

function requireEnvVar(key: string): string {
  const value = getEnvVar(key);
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. Set it in ~/.agentmemory/.env or as an environment variable.`,
    );
  }
  return value;
}

/**
 * Build the optional credential-refresh hook. Only the bedrock provider uses it
 * today, and only when AWS_AUTH_REFRESH is set; the mechanism itself is generic.
 * Accepts every provider type that may be invoked (primary + fallback chain) so
 * a bedrock provider reachable only via the fallback path still gets the hook.
 */
function createAuthRefresh(providerTypes: ProviderType[]): AuthRefresh | undefined {
  if (!providerTypes.includes("bedrock")) return undefined;
  const command = getEnvVar("AWS_AUTH_REFRESH");
  if (!command || !command.trim()) return undefined;
  const timeoutRaw = getEnvVar("AWS_AUTH_REFRESH_TIMEOUT_MS");
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  return new AuthRefresh({
    command,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  });
}

export function createProvider(config: ProviderConfig): ResilientProvider {
  return new ResilientProvider(
    createBaseProvider(config),
    createAuthRefresh([config.provider]),
  );
}

export function createFallbackProvider(
  config: ProviderConfig,
  fallbackConfig: FallbackConfig,
): ResilientProvider {
  if (fallbackConfig.providers.length === 0) {
    return createProvider(config);
  }

  const providers: MemoryProvider[] = [createBaseProvider(config)];
  const builtTypes: ProviderType[] = [config.provider];
  for (const providerType of fallbackConfig.providers) {
    if (providerType === config.provider) continue;
    try {
      const fbConfig: ProviderConfig = {
        provider: providerType,
        model: config.model,
        maxTokens: config.maxTokens,
      };
      providers.push(createBaseProvider(fbConfig));
      builtTypes.push(providerType);
    } catch {
      // skip unavailable fallback providers
    }
  }

  // Derive the refresh hook from every provider actually built (primary +
  // fallbacks), so a bedrock provider reachable only via the fallback chain
  // still refreshes expired credentials.
  const authRefresh = createAuthRefresh(builtTypes);
  if (providers.length > 1) {
    return new ResilientProvider(
      new FallbackChainProvider(providers),
      authRefresh,
    );
  }
  return new ResilientProvider(providers[0], authRefresh);
}

function createBaseProvider(config: ProviderConfig): MemoryProvider {
  switch (config.provider) {
    case "minimax":
      return new MinimaxProvider(
        requireEnvVar("MINIMAX_API_KEY"),
        config.model,
        config.maxTokens,
      );
    case "anthropic":
      return new AnthropicProvider(
        requireEnvVar("ANTHROPIC_API_KEY"),
        config.model,
        config.maxTokens,
        config.baseURL,
      );
    case "bedrock":
      // No requireEnvVar for a key: creds may come from the AWS credential
      // provider chain (SSO cache / IAM role) with no env var set. A region is
      // mandatory for Bedrock, though.
      return new BedrockProvider(
        config.model,
        config.maxTokens,
        requireEnvVar("AWS_REGION"),
      );
    case "gemini": {
      const geminiKey =
        getEnvVar("GEMINI_API_KEY") || getEnvVar("GOOGLE_API_KEY");
      if (!geminiKey) {
        throw new Error(
          "GEMINI_API_KEY (or GOOGLE_API_KEY) is required for the gemini provider",
        );
      }
      return new OpenRouterProvider(
        geminiKey,
        config.model,
        config.maxTokens,
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
    }
    case "openrouter":
      return new OpenRouterProvider(
        requireEnvVar("OPENROUTER_API_KEY"),
        config.model,
        config.maxTokens,
        "https://openrouter.ai/api/v1/chat/completions",
      );
    case "openai": {
      const openaiKey = getEnvVar("OPENAI_API_KEY");
      if (!openaiKey) {
        throw new Error(
          "OPENAI_API_KEY is required for the openai provider",
        );
      }
      return new OpenAIProvider(
        openaiKey,
        config.model,
        config.maxTokens,
        config.baseURL,
      );
    }
    case "noop":
      return new NoopProvider();
    case "agent-sdk":
    default:
      return new AgentSDKProvider();
  }
}
