import { fetchAuthSession } from 'aws-amplify/auth'
import { createSHA256 } from 'hash-wasm'
import type { MediaItem } from './media'

const configuredApiUrl = import.meta.env.VITE_API_BASE_URL?.trim()

export const mediaApiConfigured = Boolean(
  configuredApiUrl && !configuredApiUrl.startsWith('replace-'),
)

const apiBaseUrl = configuredApiUrl?.replace(/\/$/, '')

type ApiMedia = {
  key: string
  name: string
  originalName: string
  size: number
  uploadedAt: string | null
  kind: 'photo' | 'video'
  previewUrl: string
  collection: string
  tags: string[]
  caption: string
  favorite: boolean
}

type UploadAuthorization = {
  key: string
  fingerprint: string
  url: string
  fields: Record<string, string>
}

type MultipartAuthorization = {
  key: string
  fingerprint: string
  uploadId: string
  partSize: number
  resumed: boolean
  uploadedParts: { partNumber: number; etag: string; size: number }[]
}

export type UploadProgress = {
  phase: 'hashing' | 'uploading' | 'finalizing'
  loaded: number
  total: number
  percent: number
  resumed?: boolean
}

type ApiErrorPayload = {
  message?: string
  code?: string
  duplicate?: { name?: string }
}

const authorizedRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
  if (!apiBaseUrl) throw new Error('The media API is not configured.')
  const session = await fetchAuthSession()
  const token = session.tokens?.accessToken?.toString()
  if (!token) throw new Error('Your session has expired. Please sign in again.')

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  const payload = await response.json().catch(() => ({})) as ApiErrorPayload
  if (!response.ok) {
    if (payload.code === 'DUPLICATE_PENDING') {
      throw new Error(payload.message ?? 'An identical file upload is already in progress.')
    }
    if (payload.code === 'DUPLICATE') {
      const existingName = payload.duplicate?.name
      throw new Error(existingName
        ? `“${existingName}” is already in the media library.`
        : payload.message ?? 'This file is already in the media library.')
    }
    throw new Error(payload.message ?? 'The media service request failed.')
  }
  return payload as T
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(bytes / 1024, 0.1).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

const multipartThreshold = 100 * 1024 * 1024
const multipartConcurrency = 3

const reportProgress = (
  callback: ((progress: UploadProgress) => void) | undefined,
  phase: UploadProgress['phase'],
  loaded: number,
  total: number,
  resumed = false,
) => callback?.({
  phase,
  loaded,
  total,
  percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
  resumed,
})

const fingerprintFile = async (
  file: File,
  onProgress?: (progress: UploadProgress) => void,
) => {
  const hasher = await createSHA256()
  hasher.init()
  const chunkSize = 4 * 1024 * 1024
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, file.size)
    const chunk = await file.slice(offset, end).arrayBuffer()
    hasher.update(new Uint8Array(chunk))
    reportProgress(onProgress, 'hashing', end, file.size)
  }
  return hasher.digest('hex')
}

const putPart = (
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
) => new Promise<string>((resolve, reject) => {
  const request = new XMLHttpRequest()
  request.open('PUT', url)
  request.upload.onprogress = (event) => {
    if (event.lengthComputable) onProgress(event.loaded)
  }
  request.onerror = () => reject(new Error('The network connection was interrupted.'))
  request.onabort = () => reject(new Error('The upload was canceled.'))
  request.onload = () => {
    if (request.status < 200 || request.status >= 300) {
      reject(new Error(`S3 rejected an upload part (${request.status}).`))
      return
    }
    const etag = request.getResponseHeader('ETag')
    if (!etag) {
      reject(new Error('S3 did not return an upload-part identifier.'))
      return
    }
    onProgress(body.size)
    resolve(etag)
  }
  request.send(body)
})

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

const uploadPartWithRetry = async (
  file: File,
  authorization: MultipartAuthorization,
  partNumber: number,
  onProgress: (loaded: number) => void,
) => {
  const start = (partNumber - 1) * authorization.partSize
  const body = file.slice(start, Math.min(start + authorization.partSize, file.size))
  let lastError: unknown

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      onProgress(0)
      const signed = await authorizedRequest<{ url: string }>('/media/upload/multipart/part', {
        method: 'POST',
        body: JSON.stringify({
          key: authorization.key,
          fingerprint: authorization.fingerprint,
          uploadId: authorization.uploadId,
          partNumber,
        }),
      })
      return await putPart(signed.url, body, onProgress)
    } catch (error) {
      lastError = error
      if (attempt < 3) await wait(1000 * (2 ** attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('A file part could not be uploaded.')
}

const uploadMultipart = async (
  file: File,
  fingerprint: string,
  onProgress?: (progress: UploadProgress) => void,
) => {
  const authorization = await authorizedRequest<MultipartAuthorization>('/media/upload/multipart', {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      fingerprint,
    }),
  })
  const totalParts = Math.ceil(file.size / authorization.partSize)
  const completed = new Map(
    authorization.uploadedParts.map((part) => [part.partNumber, part.etag]),
  )
  const uploadedBytes = new Map<number, number>()
  authorization.uploadedParts.forEach((part) => uploadedBytes.set(part.partNumber, part.size))
  const updateProgress = (partNumber: number, loaded: number) => {
    uploadedBytes.set(partNumber, loaded)
    const totalLoaded = Array.from(uploadedBytes.values()).reduce((sum, value) => sum + value, 0)
    reportProgress(onProgress, 'uploading', totalLoaded, file.size, authorization.resumed)
  }
  reportProgress(
    onProgress,
    'uploading',
    Array.from(uploadedBytes.values()).reduce((sum, value) => sum + value, 0),
    file.size,
    authorization.resumed,
  )

  const pending = Array.from({ length: totalParts }, (_, index) => index + 1)
    .filter((partNumber) => !completed.has(partNumber))
  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      const partNumber = pending[cursor]
      cursor += 1
      const etag = await uploadPartWithRetry(
        file,
        authorization,
        partNumber,
        (loaded) => updateProgress(partNumber, loaded),
      )
      completed.set(partNumber, etag)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(multipartConcurrency, pending.length) }, () => worker()),
  )

  reportProgress(onProgress, 'finalizing', file.size, file.size, authorization.resumed)
  await authorizedRequest('/media/upload/multipart/complete', {
    method: 'POST',
    body: JSON.stringify({
      key: authorization.key,
      fingerprint: authorization.fingerprint,
      uploadId: authorization.uploadId,
      parts: Array.from(completed, ([partNumber, etag]) => ({ partNumber, etag }))
        .sort((left, right) => left.partNumber - right.partNumber),
    }),
  })
  return authorization.key
}

export async function listMedia(scope: 'library' | 'trash' = 'library'): Promise<MediaItem[]> {
  const result = await authorizedRequest<{ items: ApiMedia[] }>(scope === 'trash' ? '/media/trash' : '/media')
  return result.items.map((item) => ({
    id: item.key,
    key: item.key,
    bytes: item.size,
    name: item.name,
    kind: item.kind,
    src: item.previewUrl,
    collection: item.collection,
    dimensions: item.kind === 'video' ? 'Video' : 'Image',
    size: formatBytes(item.size),
    uploaded: item.uploadedAt
      ? new Date(item.uploadedAt).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : 'Unknown',
    tags: item.tags,
    caption: item.caption,
    favorite: item.favorite,
  }))
}

export async function uploadMedia(
  file: File,
  metadata: MediaMetadataUpdate = {},
  onProgress?: (progress: UploadProgress) => void,
): Promise<string> {
  const fingerprint = await fingerprintFile(file, onProgress)

  if (file.size >= multipartThreshold) {
    const key = await uploadMultipart(file, fingerprint, onProgress)
    if (Object.keys(metadata).length) {
      await updateMediaMetadata(key, { displayName: file.name, ...metadata })
    }
    return key
  }

  const authorization = await authorizedRequest<UploadAuthorization>('/media/upload', {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      fingerprint,
    }),
  })

  const form = new FormData()
  Object.entries(authorization.fields).forEach(([name, value]) => form.append(name, value))
  form.append('file', file)
  reportProgress(onProgress, 'uploading', 0, file.size)
  const upload = await fetch(authorization.url, { method: 'POST', body: form })
  if (!upload.ok) throw new Error(`S3 rejected ${file.name}.`)

  reportProgress(onProgress, 'finalizing', file.size, file.size)
  await authorizedRequest('/media/upload/complete', {
    method: 'POST',
    body: JSON.stringify({ key: authorization.key, fingerprint: authorization.fingerprint }),
  })
  if (Object.keys(metadata).length) {
    await updateMediaMetadata(authorization.key, { displayName: file.name, ...metadata })
  }
  return authorization.key
}

export async function getDownloadUrl(key: string): Promise<string> {
  const result = await authorizedRequest<{ url: string }>(
    `/media/download?key=${encodeURIComponent(key)}`,
  )
  return result.url
}

export async function trashMedia(key: string): Promise<void> {
  await authorizedRequest('/media/trash', {
    method: 'POST',
    body: JSON.stringify({ key }),
  })
}

export async function restoreMedia(key: string): Promise<void> {
  await authorizedRequest('/media/restore', {
    method: 'POST',
    body: JSON.stringify({ key }),
  })
}

export type MediaMetadataUpdate = {
  displayName?: string
  collection?: string
  tags?: string[]
  caption?: string
  favorite?: boolean
}

export async function updateMediaMetadata(key: string, updates: MediaMetadataUpdate): Promise<void> {
  await authorizedRequest('/media/metadata', {
    method: 'PATCH',
    body: JSON.stringify({ key, ...updates }),
  })
}
