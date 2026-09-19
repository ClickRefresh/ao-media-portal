import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

const bucketName = process.env.BUCKET_NAME
const metadataTableName = process.env.METADATA_TABLE_NAME
const s3 = new S3Client({})
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})
const mediaPrefix = 'media/'
const trashPrefix = 'trash/'
const maxUploadBytes = 5 * 1024 * 1024 * 1024
const allowedContentTypes = /^(image\/(jpeg|png|webp|heic|heif)|video\/(mp4|quicktime))$/

type UploadRequest = {
  fileName?: string
  contentType?: string
  size?: number
  fingerprint?: string
}

type CompleteUploadRequest = {
  key?: string
  fingerprint?: string
}

type MoveMediaRequest = {
  key?: string
}

type MetadataRequest = {
  key?: string
  displayName?: string
  collection?: string
  tags?: string[]
  caption?: string
  favorite?: boolean
}

const response = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const safeFileName = (value: string) => {
  const parts = value.split(/[\\/]/)
  const base = parts.at(-1) ?? 'upload'
  return base.normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 180)
}

const requireBucket = () => {
  if (!bucketName) throw new Error('BUCKET_NAME is not configured')
  return bucketName
}

const requireMetadataTable = () => {
  if (!metadataTableName) throw new Error('METADATA_TABLE_NAME is not configured')
  return metadataTableName
}

const duplicateResponse = (item: Record<string, unknown>) => response(409, {
  code: item.status === 'ready'
    ? 'DUPLICATE'
    : item.status === 'trashed'
      ? 'DUPLICATE_TRASHED'
      : 'DUPLICATE_PENDING',
  message: item.status === 'ready'
    ? 'This file is already in the media library.'
    : item.status === 'trashed'
      ? 'This file already exists in Trash. Restore it instead.'
      : 'An identical file is already being uploaded.',
  duplicate: {
    key: item.key,
    name: item.originalName,
    uploadedAt: item.uploadedAt ?? item.createdAt,
  },
})

const displayNameFromKey = (key: string) => {
  const name = key.split('/').at(-1) ?? key
  return name.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '')
}

const listMedia = async (status: 'ready' | 'trashed' = 'ready') => {
  const bucket = requireBucket()
  const result = await dynamodb.send(new QueryCommand({
    TableName: requireMetadataTable(),
    IndexName: 'status-uploadedAt-index',
    KeyConditionExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': status },
    ScanIndexForward: false,
    Limit: 100,
  }))

  const items = await Promise.all(
    (result.Items ?? [])
      .filter((item) => typeof item.key === 'string')
      .map(async (item) => {
        const key = String(item.key)
        const originalName = String(item.originalName ?? displayNameFromKey(key))
        const previewUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn: 15 * 60 },
        )

        return {
          key,
          name: String(item.displayName ?? originalName),
          originalName,
          size: Number(item.size ?? 0),
          uploadedAt: item.uploadedAt ?? null,
          kind: String(item.contentType ?? '').startsWith('video/') || /\.(mp4|mov)$/i.test(originalName) ? 'video' : 'photo',
          collection: String(item.collection ?? 'Unsorted uploads'),
          tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
          caption: String(item.caption ?? ''),
          favorite: Boolean(item.favorite),
          previewUrl,
        }
      }),
  )

  return response(200, { items, nextToken: result.LastEvaluatedKey ?? null })
}

const createUpload = async (body: string | undefined, subject: string) => {
  const bucket = requireBucket()
  const tableName = requireMetadataTable()
  const input = JSON.parse(body ?? '{}') as UploadRequest
  const fileName = safeFileName(input.fileName ?? '')
  const contentType = input.contentType ?? ''
  const size = Number(input.size)
  const fingerprint = input.fingerprint?.toLowerCase() ?? ''

  if (!fileName || !allowedContentTypes.test(contentType)) {
    return response(400, { message: 'Unsupported file type.' })
  }
  if (!Number.isFinite(size) || size <= 0 || size > maxUploadBytes) {
    return response(400, { message: 'Files must be between 1 byte and 5 GB.' })
  }
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    return response(400, { message: 'A valid SHA-256 file fingerprint is required.' })
  }

  const existing = await dynamodb.send(new GetCommand({
    TableName: tableName,
    Key: { fingerprint },
    ConsistentRead: true,
  }))
  const nowEpoch = Math.floor(Date.now() / 1000)
  if (existing.Item && (
    existing.Item.status === 'ready'
    || existing.Item.status === 'trashed'
    || Number(existing.Item.expiresAt) > nowEpoch
  )) {
    return duplicateResponse(existing.Item)
  }

  const now = new Date()
  const key = `${mediaPrefix}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}-${fileName}`
  const reservation = {
    fingerprint,
    key,
    originalName: fileName,
    contentType,
    size,
    uploadedBy: subject,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: nowEpoch + 10 * 60,
  }

  try {
    await dynamodb.send(new PutCommand({
      TableName: tableName,
      Item: reservation,
      ConditionExpression: 'attribute_not_exists(fingerprint) OR expiresAt < :now',
      ExpressionAttributeValues: { ':now': nowEpoch },
    }))
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error
    const duplicate = await dynamodb.send(new GetCommand({
      TableName: tableName,
      Key: { fingerprint },
      ConsistentRead: true,
    }))
    return duplicateResponse(duplicate.Item ?? reservation)
  }

  const upload = await createPresignedPost(s3, {
    Bucket: bucket,
    Key: key,
    Expires: 5 * 60,
    Fields: {
      'Content-Type': contentType,
      'x-amz-meta-original-name': fileName,
      'x-amz-meta-uploaded-by': subject,
      'x-amz-meta-sha256': fingerprint,
    },
    Conditions: [
      ['content-length-range', 1, size],
      ['eq', '$Content-Type', contentType],
      ['eq', '$x-amz-meta-sha256', fingerprint],
    ],
  })

  return response(200, { key, fingerprint, ...upload })
}

const completeUpload = async (body: string | undefined) => {
  const bucket = requireBucket()
  const tableName = requireMetadataTable()
  const input = JSON.parse(body ?? '{}') as CompleteUploadRequest
  const key = input.key ?? ''
  const fingerprint = input.fingerprint?.toLowerCase() ?? ''

  if (!key.startsWith(mediaPrefix) || key.includes('..') || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    return response(400, { message: 'Invalid upload completion request.' })
  }

  const object = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  if (object.Metadata?.sha256 !== fingerprint) {
    return response(409, { message: 'The uploaded file fingerprint could not be verified.' })
  }

  try {
    await dynamodb.send(new UpdateCommand({
      TableName: tableName,
      Key: { fingerprint },
      UpdateExpression: 'SET #status = :ready, uploadedAt = :uploadedAt, etag = :etag, displayName = if_not_exists(displayName, :displayName), #collection = if_not_exists(#collection, :collection), tags = if_not_exists(tags, :tags), favorite = if_not_exists(favorite, :favorite), caption = if_not_exists(caption, :caption) REMOVE expiresAt',
      ConditionExpression: '#key = :key',
      ExpressionAttributeNames: { '#status': 'status', '#key': 'key', '#collection': 'collection' },
      ExpressionAttributeValues: {
        ':ready': 'ready',
        ':uploadedAt': new Date().toISOString(),
        ':etag': object.ETag ?? '',
        ':key': key,
        ':displayName': String(object.Metadata?.['original-name'] ?? displayNameFromKey(key)),
        ':collection': 'Unsorted uploads',
        ':tags': [],
        ':favorite': false,
        ':caption': '',
      },
    }))
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
      return response(409, { message: 'The upload reservation no longer matches this file.' })
    }
    throw error
  }

  return response(200, { key, fingerprint })
}

const metadataForKey = async (key: string) => {
  const result = await dynamodb.send(new QueryCommand({
    TableName: requireMetadataTable(),
    IndexName: 'key-index',
    KeyConditionExpression: '#key = :key',
    ExpressionAttributeNames: { '#key': 'key' },
    ExpressionAttributeValues: { ':key': key },
    Limit: 1,
  }))
  return result.Items?.[0]
}

const cleanText = (value: unknown, maxLength: number) =>
  Array.from(String(value ?? '').normalize('NFKC'))
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, maxLength)

const updateMetadata = async (body: string | undefined) => {
  const tableName = requireMetadataTable()
  const input = JSON.parse(body ?? '{}') as MetadataRequest
  const key = input.key ?? ''
  if ((!key.startsWith(mediaPrefix) && !key.startsWith(trashPrefix)) || key.includes('..')) {
    return response(400, { message: 'Invalid media key.' })
  }

  const existing = await metadataForKey(key)
  if (!existing?.fingerprint) return response(404, { message: 'Media metadata was not found.' })

  const displayName = cleanText(input.displayName ?? existing.displayName ?? existing.originalName, 180)
  const collection = cleanText(input.collection ?? existing.collection ?? 'Unsorted uploads', 80)
  const caption = cleanText(input.caption ?? existing.caption ?? '', 1000)
  const tags = (input.tags ?? existing.tags ?? [])
    .map((tag: unknown) => cleanText(tag, 30).toLowerCase())
    .filter(Boolean)
    .filter((tag: string, index: number, values: string[]) => values.indexOf(tag) === index)
    .slice(0, 10)

  if (!displayName || !collection) {
    return response(400, { message: 'A display name and collection are required.' })
  }

  const updated = await dynamodb.send(new UpdateCommand({
    TableName: tableName,
    Key: { fingerprint: existing.fingerprint },
    UpdateExpression: 'SET displayName = :displayName, #collection = :collection, tags = :tags, favorite = :favorite, caption = :caption, updatedAt = :updatedAt',
    ConditionExpression: '#key = :key',
    ExpressionAttributeNames: { '#collection': 'collection', '#key': 'key' },
    ExpressionAttributeValues: {
      ':displayName': displayName,
      ':collection': collection,
      ':tags': tags,
      ':favorite': input.favorite ?? Boolean(existing.favorite),
      ':caption': caption,
      ':updatedAt': new Date().toISOString(),
      ':key': key,
    },
    ReturnValues: 'ALL_NEW',
  }))

  return response(200, { item: updated.Attributes })
}

const copySource = (bucket: string, key: string) =>
  `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`

const moveMedia = async (body: string | undefined, restore: boolean) => {
  const bucket = requireBucket()
  const tableName = requireMetadataTable()
  const input = JSON.parse(body ?? '{}') as MoveMediaRequest
  const sourceKey = input.key ?? ''
  const sourcePrefix = restore ? trashPrefix : mediaPrefix

  if (!sourceKey.startsWith(sourcePrefix) || sourceKey.includes('..')) {
    return response(400, { message: 'Invalid media key.' })
  }

  const metadata = await metadataForKey(sourceKey)
  if (!metadata?.fingerprint) {
    return response(404, { message: 'Media metadata was not found.' })
  }

  const destinationKey = restore
    ? String(metadata.originalKey ?? sourceKey.replace(trashPrefix, mediaPrefix))
    : sourceKey.replace(mediaPrefix, trashPrefix)

  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: copySource(bucket, sourceKey),
    Key: destinationKey,
  }))
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }))

  if (restore) {
    await dynamodb.send(new UpdateCommand({
      TableName: tableName,
      Key: { fingerprint: metadata.fingerprint },
      UpdateExpression: 'SET #status = :ready, #key = :destination REMOVE trashedAt, originalKey',
      ConditionExpression: '#key = :source',
      ExpressionAttributeNames: { '#status': 'status', '#key': 'key' },
      ExpressionAttributeValues: {
        ':ready': 'ready',
        ':destination': destinationKey,
        ':source': sourceKey,
      },
    }))
  } else {
    await dynamodb.send(new UpdateCommand({
      TableName: tableName,
      Key: { fingerprint: metadata.fingerprint },
      UpdateExpression: 'SET #status = :trashed, #key = :destination, originalKey = :source, trashedAt = :trashedAt',
      ConditionExpression: '#key = :source',
      ExpressionAttributeNames: { '#status': 'status', '#key': 'key' },
      ExpressionAttributeValues: {
        ':trashed': 'trashed',
        ':destination': destinationKey,
        ':source': sourceKey,
        ':trashedAt': new Date().toISOString(),
      },
    }))
  }

  return response(200, { key: destinationKey })
}

const createDownload = async (key: string | undefined) => {
  const bucket = requireBucket()
  if ((!key?.startsWith(mediaPrefix) && !key?.startsWith(trashPrefix)) || key.includes('..')) {
    return response(400, { message: 'Invalid media key.' })
  }
  const metadata = await metadataForKey(key)
  const downloadName = safeFileName(String(metadata?.displayName ?? metadata?.originalName ?? displayNameFromKey(key)))

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${downloadName}"`,
    }),
    { expiresIn: 5 * 60 },
  )
  return response(200, { url })
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  try {
    const route = event.requestContext.routeKey
    if (route === 'GET /media') return await listMedia()
    if (route === 'GET /media/trash') return await listMedia('trashed')
    if (route === 'POST /media/upload') {
      const subject = event.requestContext.authorizer?.jwt?.claims.sub ?? 'unknown'
      return await createUpload(event.body, String(subject))
    }
    if (route === 'POST /media/upload/complete') return await completeUpload(event.body)
    if (route === 'POST /media/trash') return await moveMedia(event.body, false)
    if (route === 'POST /media/restore') return await moveMedia(event.body, true)
    if (route === 'PATCH /media/metadata') return await updateMetadata(event.body)
    if (route === 'GET /media/download') {
      return await createDownload(event.queryStringParameters?.key)
    }
    return response(404, { message: 'Not found.' })
  } catch (error) {
    console.error(error)
    return response(500, { message: 'The media service could not complete the request.' })
  }
}
