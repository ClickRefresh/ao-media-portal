import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  DeleteCommand,
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
const multipartPartSize = 16 * 1024 * 1024
const multipartReservationSeconds = 7 * 24 * 60 * 60
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

type MultipartPartRequest = CompleteUploadRequest & {
  uploadId?: string
  partNumber?: number
}

type MultipartCompleteRequest = CompleteUploadRequest & {
  uploadId?: string
  parts?: { partNumber?: number; etag?: string }[]
}

type MultipartAbortRequest = CompleteUploadRequest & {
  uploadId?: string
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

const multipartPayload = async (item: Record<string, unknown>, resumed: boolean) => {
  const bucket = requireBucket()
  const key = String(item.key ?? '')
  const uploadId = String(item.uploadId ?? '')
  const listed = await s3.send(new ListPartsCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MaxParts: 1000,
  }))

  return {
    key,
    fingerprint: String(item.fingerprint ?? ''),
    uploadId,
    partSize: Number(item.partSize ?? multipartPartSize),
    resumed,
    uploadedParts: (listed.Parts ?? [])
      .filter((part) => part.PartNumber && part.ETag)
      .map((part) => ({
        partNumber: Number(part.PartNumber),
        etag: String(part.ETag),
        size: Number(part.Size ?? 0),
      })),
  }
}

const createMultipartUpload = async (body: string | undefined, subject: string) => {
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

  const nowEpoch = Math.floor(Date.now() / 1000)
  const existing = await dynamodb.send(new GetCommand({
    TableName: tableName,
    Key: { fingerprint },
    ConsistentRead: true,
  }))

  if (existing.Item && Number(existing.Item.expiresAt) > nowEpoch) {
    if (
      existing.Item.status === 'pending'
      && existing.Item.uploadMode === 'multipart'
      && existing.Item.uploadedBy === subject
      && existing.Item.uploadId
    ) {
      return response(200, await multipartPayload(existing.Item, true))
    }
    return duplicateResponse(existing.Item)
  }
  if (existing.Item?.status === 'ready' || existing.Item?.status === 'trashed') {
    return duplicateResponse(existing.Item)
  }

  if (existing.Item?.uploadId && existing.Item?.key) {
    await s3.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: String(existing.Item.key),
      UploadId: String(existing.Item.uploadId),
    })).catch(() => undefined)
  }

  const now = new Date()
  const key = `${mediaPrefix}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}-${fileName}`
  const created = await s3.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    Metadata: {
      'original-name': fileName,
      'uploaded-by': subject,
      sha256: fingerprint,
    },
  }))
  const uploadId = created.UploadId
  if (!uploadId) throw new Error('S3 did not create a multipart upload session.')

  const reservation = {
    fingerprint,
    key,
    originalName: fileName,
    contentType,
    size,
    uploadedBy: subject,
    status: 'pending',
    uploadMode: 'multipart',
    uploadId,
    partSize: multipartPartSize,
    createdAt: now.toISOString(),
    expiresAt: nowEpoch + multipartReservationSeconds,
  }

  try {
    await dynamodb.send(new PutCommand({
      TableName: tableName,
      Item: reservation,
      ConditionExpression: 'attribute_not_exists(fingerprint) OR expiresAt < :now',
      ExpressionAttributeValues: { ':now': nowEpoch },
    }))
  } catch (error) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
      .catch(() => undefined)
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error

    const duplicate = await dynamodb.send(new GetCommand({
      TableName: tableName,
      Key: { fingerprint },
      ConsistentRead: true,
    }))
    if (
      duplicate.Item?.status === 'pending'
      && duplicate.Item.uploadMode === 'multipart'
      && duplicate.Item.uploadedBy === subject
      && duplicate.Item.uploadId
    ) {
      return response(200, await multipartPayload(duplicate.Item, true))
    }
    return duplicateResponse(duplicate.Item ?? reservation)
  }

  return response(200, await multipartPayload(reservation, false))
}

const multipartReservation = async (
  input: CompleteUploadRequest & { uploadId?: string },
  subject: string,
) => {
  const fingerprint = input.fingerprint?.toLowerCase() ?? ''
  const key = input.key ?? ''
  const uploadId = input.uploadId ?? ''
  if (
    !key.startsWith(mediaPrefix)
    || key.includes('..')
    || !/^[a-f0-9]{64}$/.test(fingerprint)
    || !uploadId
  ) {
    return { error: response(400, { message: 'Invalid multipart upload request.' }) }
  }

  const result = await dynamodb.send(new GetCommand({
    TableName: requireMetadataTable(),
    Key: { fingerprint },
    ConsistentRead: true,
  }))
  const item = result.Item
  const nowEpoch = Math.floor(Date.now() / 1000)
  if (
    !item
    || item.status !== 'pending'
    || item.uploadMode !== 'multipart'
    || item.key !== key
    || item.uploadId !== uploadId
    || item.uploadedBy !== subject
    || Number(item.expiresAt ?? 0) <= nowEpoch
  ) {
    return { error: response(409, { message: 'This multipart upload session is no longer valid.' }) }
  }
  return { item, fingerprint, key, uploadId }
}

const createMultipartPart = async (body: string | undefined, subject: string) => {
  const input = JSON.parse(body ?? '{}') as MultipartPartRequest
  const reservation = await multipartReservation(input, subject)
  if (reservation.error) return reservation.error
  const partNumber = Number(input.partNumber)
  const expectedParts = Math.ceil(Number(reservation.item?.size ?? 0) / Number(reservation.item?.partSize ?? multipartPartSize))
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > expectedParts) {
    return response(400, { message: 'Invalid multipart part number.' })
  }

  const url = await getSignedUrl(
    s3,
    new UploadPartCommand({
      Bucket: requireBucket(),
      Key: reservation.key,
      UploadId: reservation.uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: 60 * 60 },
  )
  return response(200, { url, partNumber })
}

const completeMultipartUpload = async (body: string | undefined, subject: string) => {
  const input = JSON.parse(body ?? '{}') as MultipartCompleteRequest
  const reservation = await multipartReservation(input, subject)
  if (reservation.error) return reservation.error

  const expectedParts = Math.ceil(Number(reservation.item?.size ?? 0) / Number(reservation.item?.partSize ?? multipartPartSize))
  const parts = (input.parts ?? [])
    .map((part) => ({ PartNumber: Number(part.partNumber), ETag: String(part.etag ?? '') }))
    .sort((left, right) => left.PartNumber - right.PartNumber)
  if (
    parts.length !== expectedParts
    || parts.some((part, index) => part.PartNumber !== index + 1 || !part.ETag)
  ) {
    return response(400, { message: 'The multipart upload does not contain every expected part.' })
  }

  try {
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: requireBucket(),
      Key: reservation.key,
      UploadId: reservation.uploadId,
      MultipartUpload: { Parts: parts },
    }))
  } catch (error) {
    if ((error as { name?: string }).name !== 'NoSuchUpload') throw error
  }

  const object = await s3.send(new HeadObjectCommand({ Bucket: requireBucket(), Key: reservation.key }))
  if (object.Metadata?.sha256 !== reservation.fingerprint) {
    return response(409, { message: 'The uploaded file fingerprint could not be verified.' })
  }
  if (object.ContentLength !== Number(reservation.item.size)) {
    return response(409, { message: 'The completed upload size does not match the selected file.' })
  }

  await dynamodb.send(new UpdateCommand({
    TableName: requireMetadataTable(),
    Key: { fingerprint: reservation.fingerprint },
    UpdateExpression: 'SET #status = :ready, uploadedAt = :uploadedAt, etag = :etag, displayName = if_not_exists(displayName, :displayName), #collection = if_not_exists(#collection, :collection), tags = if_not_exists(tags, :tags), favorite = if_not_exists(favorite, :favorite), caption = if_not_exists(caption, :caption) REMOVE expiresAt, uploadId, uploadMode, partSize',
    ConditionExpression: '#key = :key AND uploadId = :uploadId',
    ExpressionAttributeNames: { '#status': 'status', '#key': 'key', '#collection': 'collection' },
    ExpressionAttributeValues: {
      ':ready': 'ready',
      ':uploadedAt': new Date().toISOString(),
      ':etag': object.ETag ?? '',
      ':key': reservation.key,
      ':uploadId': reservation.uploadId,
      ':displayName': String(object.Metadata?.['original-name'] ?? displayNameFromKey(reservation.key)),
      ':collection': 'Unsorted uploads',
      ':tags': [],
      ':favorite': false,
      ':caption': '',
    },
  }))

  return response(200, { key: reservation.key, fingerprint: reservation.fingerprint })
}

const abortMultipartUpload = async (body: string | undefined, subject: string) => {
  const input = JSON.parse(body ?? '{}') as MultipartAbortRequest
  const reservation = await multipartReservation(input, subject)
  if (reservation.error) return reservation.error

  await s3.send(new AbortMultipartUploadCommand({
    Bucket: requireBucket(),
    Key: reservation.key,
    UploadId: reservation.uploadId,
  }))
  await dynamodb.send(new DeleteCommand({
    TableName: requireMetadataTable(),
    Key: { fingerprint: reservation.fingerprint },
    ConditionExpression: 'uploadId = :uploadId',
    ExpressionAttributeValues: { ':uploadId': reservation.uploadId },
  }))
  return response(200, { aborted: true })
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
    if (route === 'POST /media/upload/multipart') {
      const subject = event.requestContext.authorizer?.jwt?.claims.sub ?? 'unknown'
      return await createMultipartUpload(event.body, String(subject))
    }
    if (route === 'POST /media/upload/multipart/part') {
      const subject = event.requestContext.authorizer?.jwt?.claims.sub ?? 'unknown'
      return await createMultipartPart(event.body, String(subject))
    }
    if (route === 'POST /media/upload/multipart/complete') {
      const subject = event.requestContext.authorizer?.jwt?.claims.sub ?? 'unknown'
      return await completeMultipartUpload(event.body, String(subject))
    }
    if (route === 'POST /media/upload/multipart/abort') {
      const subject = event.requestContext.authorizer?.jwt?.claims.sub ?? 'unknown'
      return await abortMultipartUpload(event.body, String(subject))
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
