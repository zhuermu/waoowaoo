import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

interface BedrockCredentials {
  accessKeyId: string
  secretAccessKey: string
  region: string
}

export function parseBedrockCredentials(apiKey: string): BedrockCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(apiKey)
  } catch {
    throw new Error(
      'BEDROCK_CREDENTIALS_INVALID: API Key must be JSON containing accessKeyId, secretAccessKey, region',
    )
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      'BEDROCK_CREDENTIALS_INVALID: API Key must be a JSON object',
    )
  }
  const record = parsed as Record<string, unknown>
  const accessKeyId = typeof record.accessKeyId === 'string' ? record.accessKeyId.trim() : ''
  const secretAccessKey = typeof record.secretAccessKey === 'string' ? record.secretAccessKey.trim() : ''
  const region = typeof record.region === 'string' ? record.region.trim() : ''
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error(
      'BEDROCK_CREDENTIALS_INVALID: JSON must contain non-empty accessKeyId, secretAccessKey, region',
    )
  }
  return { accessKeyId, secretAccessKey, region }
}

function resolveHttpsProxy(): string | null {
  return process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || null
}

function createProxyFetch(proxyUrl: string) {
  const dispatcher = new ProxyAgent(proxyUrl)
  return ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    return undiciFetch(
      url as Parameters<typeof undiciFetch>[0],
      { ...init as Record<string, unknown>, dispatcher } as Parameters<typeof undiciFetch>[1],
    )
  }) as unknown as typeof globalThis.fetch
}

export function createBedrockProvider(credentials: BedrockCredentials) {
  const proxyUrl = resolveHttpsProxy()
  return createAmazonBedrock({
    region: credentials.region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(proxyUrl ? { fetch: createProxyFetch(proxyUrl) } : {}),
  })
}

/**
 * Map reasoningEffort to Claude extended thinking budgetTokens.
 * Returns null when reasoning should be skipped entirely.
 */
export function mapBedrockReasoningBudget(effort: string): number | null {
  switch (effort) {
    case 'minimal': return null
    case 'low': return 2000
    case 'medium': return 5000
    case 'high': return 10000
    default: return 5000
  }
}
