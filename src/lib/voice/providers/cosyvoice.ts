import {
  SageMakerRuntimeClient,
  InvokeEndpointCommand,
} from '@aws-sdk/client-sagemaker-runtime'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { parseBedrockCredentials } from '@/lib/llm/providers/bedrock'
import { logInfo } from '@/lib/logging/core'
import { imageUrlToBase64 } from '@/lib/cos'

const DEFAULT_ENDPOINT_NAME = 'cosyvoice3-tts'
const MAX_CHUNK_CHARS = 50

interface CosyVoiceParams {
  referenceAudioUrl: string
  text: string
  apiKey: string
  speed?: number
}

interface CosyVoiceResult {
  audioData: Buffer
  audioDuration: number
}

function parseSageMakerConfig(apiKey: string) {
  const creds = parseBedrockCredentials(apiKey)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(apiKey) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  const sagemakerRegion = typeof parsed.sagemakerRegion === 'string' && parsed.sagemakerRegion.trim()
    ? parsed.sagemakerRegion.trim()
    : creds.region
  const sagemakerEndpoint = typeof parsed.sagemakerEndpoint === 'string' && parsed.sagemakerEndpoint.trim()
    ? parsed.sagemakerEndpoint.trim()
    : DEFAULT_ENDPOINT_NAME
  return { ...creds, sagemakerRegion, sagemakerEndpoint }
}

async function invokeEndpoint(
  client: SageMakerRuntimeClient,
  endpointName: string,
  text: string,
  promptB64: string | null,
  speed?: number,
): Promise<Buffer> {
  const payload: Record<string, unknown> = { text }
  if (speed && speed !== 1.0) {
    payload.speed = speed
  }
  if (promptB64) {
    payload.prompt_audio = promptB64
  }

  const resp = await client.send(new InvokeEndpointCommand({
    EndpointName: endpointName,
    ContentType: 'application/json',
    Body: JSON.stringify(payload),
  }))

  return Buffer.from(resp.Body as Uint8Array)
}

function splitText(text: string): string[] {
  if (!text || text.length <= MAX_CHUNK_CHARS) return [text]

  const sentenceDelimiters = /([。！？!?]+)/
  const rawParts = text.split(sentenceDelimiters)

  const sentences: string[] = []
  for (const part of rawParts) {
    if (!part) continue
    if (sentenceDelimiters.test(part) && sentences.length > 0) {
      sentences[sentences.length - 1] += part
    } else {
      sentences.push(part)
    }
  }

  const chunks: string[] = []
  for (const sent of sentences) {
    if (sent.length <= MAX_CHUNK_CHARS) {
      chunks.push(sent)
      continue
    }
    const commaDelimiters = /([，,、；;：:]+)/
    const subParts = sent.split(commaDelimiters)
    let buffer = ''
    for (const sub of subParts) {
      if (!sub) continue
      if (commaDelimiters.test(sub)) {
        buffer += sub
        continue
      }
      if (buffer.length + sub.length <= MAX_CHUNK_CHARS) {
        buffer += sub
      } else {
        if (buffer.trim()) chunks.push(buffer.trim())
        buffer = sub
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim())
  }

  // Merge short chunks (<15 chars) into neighbors
  const merged: string[] = []
  for (const chunk of chunks) {
    if (
      merged.length > 0 &&
      chunk.length < 15 &&
      merged[merged.length - 1].length + chunk.length <= MAX_CHUNK_CHARS
    ) {
      merged[merged.length - 1] += chunk
    } else if (
      merged.length > 0 &&
      merged[merged.length - 1].length < 15 &&
      merged[merged.length - 1].length + chunk.length <= MAX_CHUNK_CHARS
    ) {
      merged[merged.length - 1] += chunk
    } else {
      merged.push(chunk)
    }
  }

  return merged.filter((c) => c.trim())
}

function concatWavBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 1) return buffers[0]

  // Parse first WAV header to get format info
  const first = buffers[0]
  if (first.length < 44 || first.slice(0, 4).toString('ascii') !== 'RIFF') {
    return Buffer.concat(buffers)
  }

  const numChannels = first.readUInt16LE(22)
  const sampleRate = first.readUInt32LE(24)
  const bitsPerSample = first.readUInt16LE(34)
  const byteRate = first.readUInt32LE(28)
  const blockAlign = first.readUInt16LE(32)

  // Extract raw PCM data from each WAV
  const pcmChunks: Buffer[] = []
  for (const buf of buffers) {
    const dataOffset = findDataChunkOffset(buf)
    if (dataOffset >= 0) {
      const dataSize = buf.readUInt32LE(dataOffset + 4)
      pcmChunks.push(buf.slice(dataOffset + 8, dataOffset + 8 + dataSize))
    }
  }

  const totalDataSize = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const totalFileSize = 36 + totalDataSize

  // Build new WAV header
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(totalFileSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20)  // PCM format
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(totalDataSize, 40)

  return Buffer.concat([header, ...pcmChunks])
}

function findDataChunkOffset(wav: Buffer): number {
  let offset = 12
  while (offset < wav.length - 8) {
    const chunkId = wav.slice(offset, offset + 4).toString('ascii')
    const chunkSize = wav.readUInt32LE(offset + 4)
    if (chunkId === 'data') return offset
    offset += 8 + chunkSize
  }
  return -1
}

function getWavDurationMs(buf: Buffer): number {
  if (buf.length < 44 || buf.slice(0, 4).toString('ascii') !== 'RIFF') {
    return Math.round((buf.length * 8) / 128)
  }
  const byteRate = buf.readUInt32LE(28)
  const dataOffset = findDataChunkOffset(buf)
  if (dataOffset >= 0 && byteRate > 0) {
    const dataSize = buf.readUInt32LE(dataOffset + 4)
    return Math.round((dataSize / byteRate) * 1000)
  }
  return Math.round((buf.length * 8) / 128)
}

async function getPromptAudioB64(referenceAudioUrl: string): Promise<string | null> {
  try {
    const dataUrl = referenceAudioUrl.startsWith('data:')
      ? referenceAudioUrl
      : await imageUrlToBase64(referenceAudioUrl)
    // Extract base64 payload from data URI
    const commaIndex = dataUrl.indexOf(',')
    return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl
  } catch {
    return null
  }
}

function resolveHttpsProxy(): string | null {
  return process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || null
}

export async function generateVoiceWithCosyVoice(params: CosyVoiceParams): Promise<CosyVoiceResult> {
  const config = parseSageMakerConfig(params.apiKey)
  const proxyUrl = resolveHttpsProxy()
  const clientOptions: ConstructorParameters<typeof SageMakerRuntimeClient>[0] = {
    region: config.sagemakerRegion,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  }
  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl)
    clientOptions.requestHandler = new NodeHttpHandler({
      httpsAgent: agent,
      httpAgent: agent as never,
    })
  }
  const client = new SageMakerRuntimeClient(clientOptions)

  const promptB64 = await getPromptAudioB64(params.referenceAudioUrl)
  logInfo(`CosyVoice: zero-shot synthesis, region=${config.sagemakerRegion}, endpoint=${config.sagemakerEndpoint}, promptAudio=${!!promptB64}`)

  const chunks = splitText(params.text)

  if (chunks.length <= 1) {
    const wavBuf = await invokeEndpoint(client, config.sagemakerEndpoint, params.text, promptB64, params.speed)
    return {
      audioData: wavBuf,
      audioDuration: getWavDurationMs(wavBuf),
    }
  }

  logInfo(`CosyVoice: splitting text into ${chunks.length} chunks (${chunks.map((c) => c.length + 'chars').join(', ')})`)

  const wavBuffers: Buffer[] = []
  for (const chunk of chunks) {
    const wavBuf = await invokeEndpoint(client, config.sagemakerEndpoint, chunk, promptB64, params.speed)
    wavBuffers.push(wavBuf)
  }

  const mergedWav = concatWavBuffers(wavBuffers)
  return {
    audioData: mergedWav,
    audioDuration: getWavDurationMs(mergedWav),
  }
}
