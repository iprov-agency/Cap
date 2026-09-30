---
created: 2026-04-08
system: cap
status: approved
content_hash: 6058efbe320dbda33d034bc5ca2c5bcd889169f726d8c5882c22d81b05dd8cc4
target_agent: worktree
acceptance_criteria:
  - "Does the multipart /complete endpoint trigger transcribeVideo() fire-and-forget after successful upload completion (both raw and standard paths)?"
  - "Does resolveVideoSourceUrl() include raw-upload.webm as a candidate video source key?"
  - "Does transcribeVideo() reset PROCESSING status after 2 minutes and allow retry?"
  - "Does transcribeVideoWorkflow() reset transcriptionStatus to null on failure (try/catch after validateVideo)?"
depends_on:
supersedes:
repos:
  - Cap
---

# Transcription Decouple

## Problem

Cap's transcription pipeline never triggers for web recordings because it is chained behind media-server processing. The media-server fails (403 on R2 write), so transcription never starts. But transcription does not need mp4. The raw webm contains the audio. Gemini can transcribe from extracted audio regardless of video format. This change decouples transcription from the media-server by triggering it immediately after upload completes, reading the raw webm directly.

## Design

Four coordinated changes decouple transcription from the media-server pipeline:

1. **Trigger on upload complete**: The multipart `/complete` endpoint fires `transcribeVideo()` as a fire-and-forget call after both upload paths (raw recorder upload and standard upload) complete successfully. This uses the same fire-and-forget pattern as the existing `startVideoProcessingWorkflow` call. The call omits the `aiGenerationEnabled` argument so it defaults to `false`, avoiding forced AI generation on every upload.

2. **Raw webm as candidate source**: `resolveVideoSourceUrl()` adds `raw-upload.webm` as a third candidate key (`{userId}/{videoId}/raw-upload.webm`), so transcription can find the video even when result.mp4 does not exist yet and the videoUploads record has been deleted. The fetch-based probe is replaced with `bucket.headObject(key)` which uses the S3 SDK directly and is more reliable than HTTP range requests. Each candidate probe is wrapped in try/catch so transient errors on one candidate skip to the next instead of aborting the entire loop.

3. **PROCESSING stuck state recovery**: `transcribeVideo()` no longer unconditionally blocks on PROCESSING status. It reads `transcriptionStartedAt` from the video's metadata JSONB field (set when `validateVideo()` marks PROCESSING). If the timestamp is less than 2 minutes old, it returns early. Otherwise it resets the status to null and retries. This is more reliable than `updatedAt`, which changes on any video edit.

4. **Workflow failure recovery**: `transcribeVideoWorkflow()` wraps all steps after `validateVideo()` in a try/catch. On failure, it resets `transcriptionStatus` to null so the next trigger can retry, then re-throws. Temp audio cleanup runs in a `finally` block so S3 temp files are removed on both success and failure paths.

### Additional fix: Remove videoUploads phase guard

The existing `transcribeVideo()` function checks `videoUploads.phase` and returns early if the phase is "uploading", "processing", or "generating_thumbnail". For raw uploads, `startVideoProcessingWorkflow` sets the phase to "processing" before `transcribeVideo` runs, which would cause it to bail out. Since transcription is now intentionally decoupled from the processing pipeline (it works on the raw webm directly), this phase guard is removed.

### Placement of transcribeVideo calls in multipart.ts

The multipart `/complete` handler is one large Effect pipeline that returns a Promise<Response>. The handler is restructured as an async function that awaits the Effect pipeline, then fires transcribeVideo outside the Effect context. The videoId and userId are captured from the handler scope. The transcribeVideo call only fires when the Effect pipeline returns a successful response (status 200).

### Audio cleanup on failure paths

`extractAudio` returns both `audioUrl` and `audioKey`. `cleanupTempAudio` accepts `(audioKey, bucketId)` instead of `(videoId, userId, bucketId)`. The workflow captures `audioKey` and runs cleanup in a `finally` block, ensuring temp audio is removed even when transcription or save steps fail.

## Acceptance Criteria

- [ ] Does the multipart /complete endpoint trigger transcribeVideo() fire-and-forget after successful upload completion (both raw and standard paths)?
- [ ] Does resolveVideoSourceUrl() include `raw-upload.webm` as a candidate video source key?
- [ ] Does transcribeVideo() reset PROCESSING status after 2 minutes and allow retry?
- [ ] Does transcribeVideoWorkflow() reset transcriptionStatus to null on failure (try/catch after validateVideo)?

## Implementation

### `packages/database/types/metadata.ts`

Adding `transcriptionStartedAt` to the `VideoMetadata` interface so the PROCESSING staleness check can use a dedicated timestamp instead of the unreliable `updatedAt` field.

```typescript
export interface VideoMetadata {
	customCreatedAt?: string;
	sourceName?: string;
	aiTitle?: string;
	summary?: string;
	chapters?: { title: string; start: number }[];
	aiGenerationStatus?:
		| "QUEUED"
		| "PROCESSING"
		| "COMPLETE"
		| "ERROR"
		| "SKIPPED";
	enhancedAudioStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";
	transcriptionStartedAt?: number;
}

export interface SpaceMetadata {
	[key: string]: never;
}

export interface UserMetadata {
	[key: string]: never;
}
```

### `apps/web/app/api/upload/[...route]/multipart.ts`

The transcribeVideo call omits the third argument so `aiGenerationEnabled` defaults to `false`, preventing forced AI generation on every upload.

```typescript
import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { updateIfDefined } from "@cap/database";
import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import {
	AwsCredentials,
	Database,
	makeCurrentUserLayer,
	provideOptionalAuth,
	S3Buckets,
	VideosPolicy,
	VideosRepo,
} from "@cap/web-backend";
import { Policy, Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Effect, Option, Schedule } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";
import { runPromise } from "@/lib/server";
import { transcribeVideo } from "@/lib/transcribe";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { stringOrNumberOptional } from "@/utils/zod";
import {
	getMultipartFileKey,
	getSubpath,
	isRawRecorderUpload,
} from "./multipart-utils";

export const app = new Hono().use(withAuth);

const runPromiseAnyEnv = runPromise as <A, E>(
	effect: Effect.Effect<A, E, unknown>,
) => Promise<A>;

const abortRequestSchema = z
	.object({
		uploadId: z.string(),
	})
	.and(
		z.union([
			z.object({ videoId: z.string(), subpath: z.string().optional() }),
			z.object({ fileKey: z.string() }),
		]),
	);

type AbortRequestInput = z.input<typeof abortRequestSchema>;

type AbortValidatorInput = {
	in: { json: AbortRequestInput };
	out: { json: z.output<typeof abortRequestSchema> };
};

const abortRequestValidator = zValidator(
	"json",
	abortRequestSchema,
) as MiddlewareHandler<Record<string, never>, "/abort", AbortValidatorInput>;

app.post(
	"/initiate",
	zValidator(
		"json",
		z.object({ contentType: z.string() }).and(
			z.union([
				z.object({ videoId: z.string(), subpath: z.string().optional() }),
				z.object({ fileKey: z.string() }),
			]),
		),
	),
	async (c) => {
		const { contentType, ...body } = c.req.valid("json");
		const user = c.get("user");

		const fileKey = getMultipartFileKey(user.id, body);

		const videoIdFromFileKey = fileKey.split("/")[1];
		const videoIdRaw = "videoId" in body ? body.videoId : videoIdFromFileKey;
		if (!videoIdRaw) return c.text("Video id not found", 400);
		const videoId = Video.VideoId.make(videoIdRaw);

		const resp = await Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const policy = yield* VideosPolicy;
			const db = yield* Database;

			const video = yield* repo
				.getById(videoId)
				.pipe(Policy.withPolicy(policy.isOwner(videoId)));
			if (Option.isNone(video)) return yield* new Video.NotFoundError();

			yield* db.use((db) =>
				db
					.insert(Db.videoUploads)
					.values({
						videoId: video.value[0].id,
						mode: "multipart",
					})
					.onDuplicateKeyUpdate({
						set: {
							mode: "multipart",
							updatedAt: new Date(),
						},
					}),
			);
		}).pipe(
			Effect.tapError(Effect.logError),
			Effect.catchAll((e) => {
				if (e._tag === "VideoNotFoundError")
					return Effect.succeed<Response>(c.text("Video not found", 404));

				return Effect.succeed<Response>(
					c.json({ error: "Error initiating multipart upload" }, 500),
				);
			}),
			Effect.provide(makeCurrentUserLayer(user)),
			provideOptionalAuth,
			runPromiseAnyEnv,
		);
		if (resp) return resp;

		try {
			try {
				const uploadId = await Effect.gen(function* () {
					const [bucket] = yield* S3Buckets.getBucketAccessForUser(user.id);

					const finalContentType = contentType || "video/mp4";
					console.log(
						`Creating multipart upload in bucket: ${bucket.bucketName}, content-type: ${finalContentType}, key: ${fileKey}`,
					);

					const { UploadId } = yield* bucket.multipart.create(fileKey, {
						ContentType: finalContentType,
						Metadata: {
							userId: user.id,
							source: "cap-multipart-upload",
						},
						CacheControl: "max-age=31536000",
					});

					if (!UploadId) {
						throw new Error("No UploadId returned from S3");
					}

					console.log(
						`Successfully initiated multipart upload with ID: ${UploadId}`,
					);
					console.log(
						`Upload details: Bucket=${bucket.bucketName}, Key=${fileKey}, ContentType=${finalContentType}`,
					);

					return UploadId;
				}).pipe(provideOptionalAuth, runPromiseAnyEnv);

				return c.json({ uploadId: uploadId });
			} catch (s3Error) {
				console.error("S3 operation failed:", s3Error);
				throw new Error(
					`S3 operation failed: ${
						s3Error instanceof Error ? s3Error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			console.error("Error initiating multipart upload", error);
			return c.json(
				{
					error: "Error initiating multipart upload",
					details: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
	},
);

app.post(
	"/presign-part",
	zValidator(
		"json",
		z
			.object({
				uploadId: z.string(),
				partNumber: z.number(),
				md5Sum: z.string().optional(),
			})
			.and(
				z.union([
					z.object({ videoId: z.string(), subpath: z.string().optional() }),
					z.object({ fileKey: z.string() }),
				]),
			),
	),
	async (c) => {
		const { uploadId, partNumber, ...body } = c.req.valid("json");
		const user = c.get("user");

		const fileKey = getMultipartFileKey(user.id, body);

		try {
			try {
				const presignedUrl = await Effect.gen(function* () {
					const [bucket] = yield* S3Buckets.getBucketAccessForUser(user.id);

					console.log(
						`Getting presigned URL for part ${partNumber} of upload ${uploadId}`,
					);

					const presignedUrl =
						yield* bucket.multipart.getPresignedUploadPartUrl(
							fileKey,
							uploadId,
							partNumber,
							{ ContentMD5: body.md5Sum },
						);

					return presignedUrl;
				}).pipe(provideOptionalAuth, runPromiseAnyEnv);

				return c.json({ presignedUrl });
			} catch (s3Error) {
				console.error("S3 operation failed:", s3Error);
				throw new Error(
					`S3 operation failed: ${
						s3Error instanceof Error ? s3Error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			console.error("Error creating presigned URL for part", error);
			return c.json(
				{
					error: "Error creating presigned URL for part",
					details: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
	},
);

app.post(
	"/complete",
	zValidator(
		"json",
		z
			.object({
				uploadId: z.string(),
				parts: z.array(
					z.object({
						partNumber: z.number(),
						etag: z.string(),
						size: z.number(),
					}),
				),
				durationInSecs: stringOrNumberOptional,
				width: stringOrNumberOptional,
				height: stringOrNumberOptional,
				fps: stringOrNumberOptional,
			})
			.and(
				z.union([
					z.object({ videoId: z.string(), subpath: z.string().optional() }),
					z.object({ fileKey: z.string() }),
				]),
			),
	),
	async (c) => {
		const { uploadId, parts, ...body } = c.req.valid("json");
		const user = c.get("user");

		const fileKey = getMultipartFileKey(user.id, body);
		const videoIdFromFileKey = fileKey.split("/")[1];
		const videoIdRaw = "videoId" in body ? body.videoId : videoIdFromFileKey;

		const response = await Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const policy = yield* VideosPolicy;
			const db = yield* Database;

			const subpath = getSubpath(body) ?? "result.mp4";

			if (!videoIdRaw) return c.text("Video id not found", 400);
			const videoId = Video.VideoId.make(videoIdRaw);

			const maybeVideo = yield* repo
				.getById(videoId)
				.pipe(Policy.withPolicy(policy.isOwner(videoId)));
			if (Option.isNone(maybeVideo)) {
				c.status(404);
				return c.text(`Video '${encodeURIComponent(videoId)}' not found`);
			}
			const [video] = maybeVideo.value;

			return yield* Effect.gen(function* () {
				const [bucket, customBucket] = yield* S3Buckets.getBucketAccess(
					video.bucketId,
				);

				const { result, formattedParts } = yield* Effect.gen(function* () {
					console.log(
						`Completing multipart upload ${uploadId} with ${parts.length} parts for key: ${fileKey}`,
					);

					const totalSize = parts.reduce((acc, part) => acc + part.size, 0);
					console.log(`Total size of all parts: ${totalSize} bytes`);

					const sortedParts = [...parts].sort(
						(a, b) => a.partNumber - b.partNumber,
					);

					const sequentialCheck = sortedParts.every(
						(part, index) => part.partNumber === index + 1,
					);

					if (!sequentialCheck) {
						console.warn(
							"WARNING: Part numbers are not sequential! This may cause issues with the assembled file.",
						);
					}

					const formattedParts = sortedParts.map((part) => ({
						PartNumber: part.partNumber,
						ETag: part.etag,
					}));

					console.log(
						"Sending to S3:",
						JSON.stringify(
							{
								Bucket: bucket.bucketName,
								Key: fileKey,
								UploadId: uploadId,
								Parts: formattedParts,
							},
							null,
							2,
						),
					);

					const result = yield* bucket.multipart.complete(fileKey, uploadId, {
						MultipartUpload: {
							Parts: formattedParts,
						},
					});

					return { result, formattedParts };
				});

				return yield* Effect.gen(function* () {
					console.log(
						`Multipart upload completed successfully: ${
							result.Location || "no location"
						}`,
					);
					console.log(`Complete response: ${JSON.stringify(result, null, 2)}`);

					yield* bucket.headObject(fileKey).pipe(
						Effect.tap((headResult) =>
							Effect.log(
								`Object verification successful: ContentType=${headResult.ContentType}, ContentLength=${headResult.ContentLength}`,
							),
						),
						Effect.catchAll((headError) =>
							Effect.logError(`Warning: Unable to verify object: ${headError}`),
						),
						Effect.retry({
							times: 3,
							schedule: Schedule.exponential("50 millis"),
						}),
					);

					if (isRawRecorderUpload(subpath)) {
						yield* db.use((db) =>
							db
								.update(Db.videos)
								.set({
									duration: updateIfDefined(
										body.durationInSecs,
										Db.videos.duration,
									),
									width: updateIfDefined(body.width, Db.videos.width),
									height: updateIfDefined(body.height, Db.videos.height),
									fps: updateIfDefined(body.fps, Db.videos.fps),
								})
								.where(
									and(
										eq(Db.videos.id, Video.VideoId.make(videoId)),
										eq(Db.videos.ownerId, user.id),
									),
								),
						);

						const processingStarted = yield* Effect.tryPromise(() =>
							startVideoProcessingWorkflow({
								videoId: Video.VideoId.make(videoId),
								userId: user.id,
								rawFileKey: fileKey,
								bucketId: Option.getOrNull(video.bucketId),
								processingMessage: "Starting video processing...",
								startFailureMessage:
									"Video uploaded, but processing could not start.",
								mode: "multipart",
							}),
						).pipe(
							Effect.map(() => true),
							Effect.catchAll((error) =>
								Effect.logError(
									"Failed to start video processing workflow after raw upload completion",
									error,
								).pipe(Effect.map(() => false)),
							),
						);

						return c.json({
							location: result.Location,
							success: true,
							fileKey,
							processingStarted,
						});
					}

					console.log(
						"Performing metadata fix by copying the object to itself...",
					);

					yield* bucket
						.copyObject(`${bucket.bucketName}/${fileKey}`, fileKey, {
							ContentType: "video/mp4",
							MetadataDirective: "REPLACE",
						})
						.pipe(
							Effect.tap((result) =>
								Effect.log("Copy for metadata fix successful:", result),
							),
							Effect.catchAll((e) =>
								Effect.logError(
									"Warning: Failed to copy object to fix metadata:",
									e,
								),
							),
							Effect.retry({
								times: 3,
								schedule: Schedule.exponential("50 millis"),
							}),
						);

					yield* db.use((db) =>
						db.transaction(() =>
							Promise.all([
								db
									.update(Db.videos)
									.set({
										duration: updateIfDefined(
											body.durationInSecs,
											Db.videos.duration,
										),
										width: updateIfDefined(body.width, Db.videos.width),
										height: updateIfDefined(body.height, Db.videos.height),
										fps: updateIfDefined(body.fps, Db.videos.fps),
									})
									.where(
										and(
											eq(Db.videos.id, Video.VideoId.make(videoId)),
											eq(Db.videos.ownerId, user.id),
										),
									),
								db
									.delete(Db.videoUploads)
									.where(
										eq(Db.videoUploads.videoId, Video.VideoId.make(videoId)),
									),
							]),
						),
					);

					const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
					if (video.source.type === "webMP4" && mediaServerUrl) {
						const inputUrl = yield* bucket.getInternalSignedObjectUrl(fileKey);
						const outputPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
							fileKey,
							{
								ContentType: "video/mp4",
								CacheControl: "max-age=31536000",
								Metadata: {
									userId: user.id,
									source: "cap-multipart-upload",
								},
							},
						);

						yield* Effect.tryPromise({
							try: async () => {
								const response = await fetch(
									`${mediaServerUrl}/video/process`,
									{
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({
											videoId,
											userId: user.id,
											videoUrl: inputUrl,
											outputPresignedUrl,
											remuxOnly: true,
										}),
									},
								);

								if (!response.ok) {
									const errorText = await response.text().catch(() => "");
									throw new Error(
										`Media server remux failed: ${response.status} ${errorText}`,
									);
								}
							},
							catch: (cause) =>
								cause instanceof Error ? cause : new Error(String(cause)),
						}).pipe(
							Effect.catchAll((error) => {
								console.error("Failed to queue faststart remux:", error);
								return Effect.succeed(null);
							}),
						);
					}

					if (Option.isNone(customBucket)) {
						const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
						if (distributionId) {
							const cloudfront = new CloudFrontClient({
								region: serverEnv().CAP_AWS_REGION || "us-east-1",
								credentials: yield* Effect.map(
									AwsCredentials,
									(c) => c.credentials,
								),
							});

							const pathToInvalidate = `/${fileKey}`;

							yield* Effect.promise(() =>
								cloudfront.send(
									new CreateInvalidationCommand({
										DistributionId: distributionId,
										InvalidationBatch: {
											CallerReference: `${Date.now()}`,
											Paths: {
												Quantity: 1,
												Items: [pathToInvalidate],
											},
										},
									}),
								),
							).pipe(
								Effect.catchAll((e) =>
									Effect.logError(
										"Failed to create CloudFront invalidation:",
										e,
									),
								),
								Effect.withSpan("CloudFrontInvalidation"),
							);
						}
					}

					return c.json({
						location: result.Location,
						success: true,
						fileKey,
					});
				}).pipe(
					Effect.catchAllCause((completeError) => {
						console.error(
							"Failed to complete multipart upload:",
							completeError,
						);
						return Effect.succeed(
							c.json(
								{
									error: "Failed to complete multipart upload",
									details:
										completeError instanceof Error
											? completeError.message
											: String(completeError),
									uploadId,
									fileKey,
									parts: formattedParts.length,
								},
								500,
							),
						);
					}),
				);
			}).pipe(
				Effect.catchAll((error) => {
					console.error("Multipart upload failed:", error);

					return Effect.succeed(
						c.json(
							{
								error: "Error completing multipart upload",
								details: error instanceof Error ? error.message : String(error),
							},
							500,
						),
					);
				}),
			);
		}).pipe(
			Effect.provide(makeCurrentUserLayer(user)),
			provideOptionalAuth,
			runPromiseAnyEnv,
		);

		if (videoIdRaw && response.status === 200) {
			transcribeVideo(
				Video.VideoId.make(videoIdRaw),
				user.id,
			).catch((err) => {
				console.error(
					`[multipart] Transcription trigger failed for ${videoIdRaw}:`,
					err,
				);
			});
		}

		return response;
	},
);

app.post("/abort", abortRequestValidator, (c) => {
	const { uploadId, ...body } = c.req.valid("json");
	const user = c.get("user");

	const fileKey = getMultipartFileKey(user.id, body);

	const videoIdFromFileKey = fileKey.split("/")[1];
	const videoIdRaw = "videoId" in body ? body.videoId : videoIdFromFileKey;
	if (!videoIdRaw) return c.text("Video id not found", 400);
	const videoId = Video.VideoId.make(videoIdRaw);

	return Effect.gen(function* () {
		const repo = yield* VideosRepo;
		const policy = yield* VideosPolicy;
		const db = yield* Database;

		const maybeVideo = yield* repo
			.getById(videoId)
			.pipe(Policy.withPolicy(policy.isOwner(videoId)));
		if (Option.isNone(maybeVideo)) {
			c.status(404);
			return c.text(`Video '${encodeURIComponent(videoId)}' not found`);
		}
		const [video] = maybeVideo.value;

		const [bucket] = yield* S3Buckets.getBucketAccess(video.bucketId);
		type MultipartWithAbort = typeof bucket.multipart & {
			abort: (
				...args: Parameters<typeof bucket.multipart.complete>
			) => ReturnType<typeof bucket.multipart.complete>;
		};
		const multipart = bucket.multipart as MultipartWithAbort;

		console.log(`Aborting multipart upload ${uploadId} for key: ${fileKey}`);
		yield* multipart.abort(fileKey, uploadId);

		yield* db.use((db) =>
			db.delete(Db.videoUploads).where(eq(Db.videoUploads.videoId, videoId)),
		);

		return c.json({ success: true, fileKey, uploadId });
	}).pipe(
		Effect.catchAll((error) => {
			console.error("Failed to abort multipart upload:", error);

			return Effect.succeed(
				c.json(
					{
						error: "Failed to abort multipart upload",
						details: error instanceof Error ? error.message : String(error),
					},
					500,
				),
			);
		}),
		Effect.provide(makeCurrentUserLayer(user)),
		provideOptionalAuth,
		runPromiseAnyEnv,
	);
});
```

### `apps/web/lib/transcribe.ts`

The PROCESSING stuck state check now reads `transcriptionStartedAt` from the video's metadata JSON field instead of using the unreliable `updatedAt` timestamp. The videoUploads phase guard is removed since transcription is decoupled from the processing pipeline.

```typescript
import { db } from "@cap/database";
import {
	organizations,
	s3Buckets,
	videos,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

type TranscribeResult = {
	success: boolean;
	message: string;
};

const PROCESSING_TIMEOUT_MS = 2 * 60 * 1000;

export async function transcribeVideo(
	videoId: Video.VideoId,
	userId: string,
	aiGenerationEnabled = false,
	_isRetry = false,
): Promise<TranscribeResult> {
	if (!serverEnv().GOOGLE_API_KEY) {
		return {
			success: false,
			message: "Missing GOOGLE_API_KEY for Gemini transcription",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
			settings: videos.settings,
			orgSettings: organizations.settings,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video does not exist" };
	}

	const result = query[0];
	if (!result || !result.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (!video) {
		return { success: false, message: "Video information is missing" };
	}

	if (
		video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript
	) {
		console.log(
			`[transcribeVideo] Transcription disabled for video ${videoId}`,
		);
		try {
			await db()
				.update(videos)
				.set({ transcriptionStatus: "SKIPPED" })
				.where(eq(videos.id, videoId));
		} catch (err) {
			console.error(`[transcribeVideo] Failed to mark as skipped:`, err);
			return {
				success: false,
				message: "Transcription disabled, but failed to update status",
			};
		}
		return {
			success: true,
			message: "Transcription disabled for video, skipping transcription",
		};
	}

	if (
		video.transcriptionStatus === "COMPLETE" ||
		video.transcriptionStatus === "SKIPPED" ||
		video.transcriptionStatus === "NO_AUDIO"
	) {
		return {
			success: true,
			message: "Transcription already completed",
		};
	}

	if (video.transcriptionStatus === "PROCESSING") {
		const metadata = (video.metadata ?? {}) as VideoMetadata;
		const startedAt = metadata.transcriptionStartedAt;
		if (startedAt && Date.now() - startedAt < PROCESSING_TIMEOUT_MS) {
			return {
				success: true,
				message: "Transcription already in progress",
			};
		}
		console.log(
			`[transcribeVideo] PROCESSING status stale for ${videoId}, resetting`,
		);
		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));
	}

	try {
		console.log(
			`[transcribeVideo] Triggering transcription workflow for video ${videoId}`,
		);

		transcribeVideoWorkflow({
			videoId,
			userId,
			aiGenerationEnabled,
		}).catch((err) => {
			console.error(`[transcribeVideo] Workflow failed for ${videoId}:`, err);
		});

		return {
			success: true,
			message: "Transcription workflow started",
		};
	} catch (error) {
		console.error("[transcribeVideo] Failed to trigger workflow:", error);

		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));

		return {
			success: false,
			message: "Failed to start transcription workflow",
		};
	}
}
```

### `apps/web/workflows/transcribe.ts`

Four fixes applied: (1) `validateVideo()` writes `transcriptionStartedAt` to metadata via `JSON_SET` when setting PROCESSING status. (2) `resolveVideoSourceUrl()` adds `raw-upload.webm` as a candidate and uses `bucket.headObject()` instead of fetch probes, with per-candidate try/catch. (3) `extractAudio` returns `{ audioUrl, audioKey } | null` and `cleanupTempAudio` accepts `(audioKey, bucketId)`. (4) `transcribeVideoWorkflow()` runs cleanup in a `finally` block.

```typescript
import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import {
	organizations,
	s3Buckets,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { Option } from "effect";

class FatalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FatalError";
	}
}

import {
	ENHANCED_AUDIO_CONTENT_TYPE,
	ENHANCED_AUDIO_EXTENSION,
	enhanceAudioFromUrl,
} from "@/lib/audio-enhance";
import { checkHasAudioTrack, extractAudioFromUrl } from "@/lib/audio-extract";
import { startAiGeneration } from "@/lib/generate-ai";
import {
	GEMINI_AUDIO_MODEL,
	getGeminiClient,
} from "@/lib/gemini-client";
import {
	checkHasAudioTrackViaMediaServer,
	extractAudioViaMediaServer,
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "@/lib/media-client";
import { runPromise } from "@/lib/server";
import { geminiTextToWebVTT } from "@/lib/transcribe-utils";

interface TranscribeWorkflowPayload {
	videoId: string;
	userId: string;
	aiGenerationEnabled: boolean;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	bucketId: S3Bucket.S3BucketId | null;
	transcriptionDisabled: boolean;
	isOwnerPro: boolean;
}

export async function transcribeVideoWorkflow(
	payload: TranscribeWorkflowPayload,
) {

	const { videoId, userId, aiGenerationEnabled } = payload;

	const videoData = await validateVideo(videoId);

	let audioKey: string | null = null;
	try {
		if (videoData.transcriptionDisabled) {
			await markSkipped(videoId);
			return { success: true, message: "Transcription disabled - skipped" };
		}

		const extracted = await extractAudio(videoId, userId, videoData.bucketId);

		if (!extracted) {
			await markNoAudio(videoId);
			return {
				success: true,
				message: "Video has no audio track - skipped transcription",
			};
		}

		audioKey = extracted.audioKey;

		const [transcription] = await Promise.all([
			transcribeWithGemini(extracted.audioUrl),
		]);

		await saveTranscription(videoId, userId, videoData.bucketId, transcription);

		if (aiGenerationEnabled) {
			await queueAiGeneration(videoId, userId);
		}

		return { success: true, message: "Transcription completed successfully" };
	} catch (error) {
		console.error(`[transcribe] Workflow failed for ${videoId}:`, error);
		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId as Video.VideoId));
		throw error;
	} finally {
		if (audioKey) {
			await cleanupTempAudio(audioKey, videoData.bucketId).catch(() => {});
		}
	}
}

async function validateVideo(videoId: string): Promise<VideoData> {

	if (!serverEnv().GOOGLE_API_KEY) {
		throw new FatalError("Missing GOOGLE_API_KEY for Gemini transcription");
	}

	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
			settings: videos.settings,
			orgSettings: organizations.settings,
			owner: users,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0) {
		throw new FatalError("Video does not exist");
	}

	const result = query[0];
	if (!result?.video) {
		throw new FatalError("Video information is missing");
	}

	const transcriptionDisabled =
		result.video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript ??
		false;

	const isOwnerPro = userIsPro(result.owner);

	console.log(
		`[transcribe] Owner check: stripeSubscriptionStatus=${result.owner.stripeSubscriptionStatus}, thirdPartyStripeSubscriptionId=${result.owner.thirdPartyStripeSubscriptionId}, isOwnerPro=${isOwnerPro}`,
	);

	await db()
		.update(videos)
		.set({
			transcriptionStatus: "PROCESSING",
			metadata: sql`JSON_SET(COALESCE(metadata, '{}'), '$.transcriptionStartedAt', ${Date.now()})`,
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video: result.video,
		bucketId: (result.bucket?.id ?? null) as S3Bucket.S3BucketId | null,
		transcriptionDisabled,
		isOwnerPro,
	};
}

async function markSkipped(videoId: string): Promise<void> {

	await db()
		.update(videos)
		.set({ transcriptionStatus: "SKIPPED" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function markNoAudio(videoId: string): Promise<void> {

	await db()
		.update(videos)
		.set({ transcriptionStatus: "NO_AUDIO" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function extractAudio(
	videoId: string,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<{ audioUrl: string; audioKey: string } | null> {

	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(bucketId),
	).pipe(runPromise);

	const videoUrl = await resolveVideoSourceUrl(videoId, userId, bucketId);

	const useMediaServer = isMediaServerConfigured();
	console.log(
		`[transcribe] Audio detection: useMediaServer=${useMediaServer}, videoId=${videoId}`,
	);

	let hasAudio: boolean;
	let audioBuffer: Buffer;

	if (useMediaServer) {
		try {
			const probe = await probeVideoViaMediaServer(videoUrl);
			console.log(
				`[transcribe] Probe result for ${videoId}: audioCodec=${probe.audioCodec}, videoCodec=${probe.videoCodec}, duration=${probe.duration}, audioChannels=${probe.audioChannels}, sampleRate=${probe.sampleRate}`,
			);
			hasAudio = probe.audioCodec !== null;
		} catch (probeError) {
			console.error(
				`[transcribe] Probe failed for ${videoId}, falling back to audio check:`,
				probeError,
			);
			hasAudio = await checkHasAudioTrackViaMediaServer(videoUrl);
			console.log(
				`[transcribe] Fallback audio check result for ${videoId}: hasAudio=${hasAudio}`,
			);
		}

		if (!hasAudio) {
			console.log(
				`[transcribe] No audio track detected for ${videoId} via media server`,
			);
			return null;
		}

		audioBuffer = await extractAudioViaMediaServer(videoUrl);
	} else {
		hasAudio = await checkHasAudioTrack(videoUrl);
		console.log(
			`[transcribe] Local ffmpeg audio check for ${videoId}: hasAudio=${hasAudio}`,
		);
		if (!hasAudio) {
			return null;
		}

		const result = await extractAudioFromUrl(videoUrl);

		try {
			audioBuffer = await fs.readFile(result.filePath);
		} finally {
			await result.cleanup();
		}
	}

	console.log(
		`[transcribe] Extracted audio for ${videoId}: ${audioBuffer.length} bytes`,
	);

	const audioKey = `${userId}/${videoId}/audio-temp.mp3`;

	await bucket
		.putObject(audioKey, audioBuffer, {
			contentType: "audio/mpeg",
		})
		.pipe(runPromise);

	const audioSignedUrl = await bucket
		.getInternalSignedObjectUrl(audioKey)
		.pipe(runPromise);

	return { audioUrl: audioSignedUrl, audioKey };
}

async function resolveVideoSourceUrl(
	videoId: string,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<string> {
	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(bucketId),
	).pipe(runPromise);

	const upload = await db()
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId))
		.limit(1);

	const candidateKeys = [
		`${userId}/${videoId}/result.mp4`,
		upload[0]?.rawFileKey,
		`${userId}/${videoId}/raw-upload.webm`,
	].filter(
		(value, index, values): value is string =>
			Boolean(value) && values.indexOf(value) === index,
	);

	for (const key of candidateKeys) {
		try {
			await bucket.headObject(key).pipe(runPromise);
			const url = await bucket.getInternalSignedObjectUrl(key).pipe(runPromise);
			console.log(`[transcribe] Using video source ${key}`);
			return url;
		} catch {
			continue;
		}
	}

	throw new Error("Video file not accessible");
}

async function transcribeWithGemini(audioUrl: string): Promise<string> {

	const gemini = getGeminiClient();
	if (!gemini) {
		throw new Error("Gemini client not configured");
	}

	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}

	const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
	const audioBase64 = audioBuffer.toString("base64");

	const model = gemini.getGenerativeModel({ model: GEMINI_AUDIO_MODEL });

	const result = await model.generateContent([
		{
			inlineData: {
				mimeType: "audio/mpeg",
				data: audioBase64,
			},
		},
		{
			text: `Transcribe this audio accurately. Include timestamps for each segment.
Format each line as: [MM:SS] transcribed text
For example:
[0:00] Hello and welcome to this video.
[0:05] Today we're going to talk about...

Be precise with the timestamps and transcribe every word spoken. If there are multiple speakers, note speaker changes.`,
		},
	]);

	const transcriptionText = result.response.text();

	if (!transcriptionText || transcriptionText.trim().length === 0) {
		throw new Error("Gemini returned empty transcription");
	}

	return geminiTextToWebVTT(transcriptionText);
}

async function saveTranscription(
	videoId: string,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
	transcription: string,
): Promise<void> {

	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(bucketId),
	).pipe(runPromise);

	await bucket
		.putObject(`${userId}/${videoId}/transcription.vtt`, transcription, {
			contentType: "text/vtt",
		})
		.pipe(runPromise);

	await db()
		.update(videos)
		.set({ transcriptionStatus: "COMPLETE" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function cleanupTempAudio(
	audioKey: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<void> {

	try {
		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		).pipe(runPromise);

		await bucket.deleteObject(audioKey).pipe(runPromise);
	} catch (error) {
		console.error(
			`[transcribe] Failed to cleanup temp audio file: ${audioKey}`,
			error,
		);
	}
}

async function queueAiGeneration(
	videoId: string,
	userId: string,
): Promise<void> {

	await startAiGeneration(videoId as Video.VideoId, userId);
}

async function _markEnhancedAudioProcessing(videoId: string): Promise<void> {

	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	const currentMetadata = (video?.metadata as VideoMetadata) || {};

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				enhancedAudioStatus: "PROCESSING",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function _enhanceAndSaveAudio(
	videoId: string,
	userId: string,
	audioUrl: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<void> {

	console.log(`[transcribe] Starting audio enhancement for video ${videoId}`);

	try {
		const enhancedBuffer = await enhanceAudioFromUrl(audioUrl);
		console.log(
			`[transcribe] Audio enhanced, saving to S3 (${enhancedBuffer.length} bytes)`,
		);

		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		).pipe(runPromise);

		const enhancedAudioKey = `${userId}/${videoId}/enhanced-audio.${ENHANCED_AUDIO_EXTENSION}`;

		await bucket
			.putObject(enhancedAudioKey, enhancedBuffer, {
				contentType: ENHANCED_AUDIO_CONTENT_TYPE,
			})
			.pipe(runPromise);

		const [video] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (video?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "COMPLETE",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	} catch (error) {
		console.error(
			`[transcribe] Audio enhancement failed for video ${videoId}:`,
			error,
		);

		const [video] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (video?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	}
}
```

## Open Questions

- The `_markEnhancedAudioProcessing` and `_enhanceAndSaveAudio` functions in `workflows/transcribe.ts` are prefixed with underscores (dead code). They were left in to avoid unrelated churn. A follow-up cleanup spec could remove them.
- The share page (`app/s/[videoId]/page.tsx`) and embed page (`app/embed/[videoId]/page.tsx`) also trigger `transcribeVideo` on page load. With this change, transcription may already be PROCESSING or COMPLETE by the time someone visits the share page. This is harmless (the guards prevent duplicate work) but means there are now two trigger paths for transcription: upload-complete and page-view.
- The `JSON_SET` approach in `validateVideo()` performs an atomic JSON update at the database level, avoiding read-modify-write races that could overwrite other metadata fields. Other metadata writers in the codebase (e.g., `_markEnhancedAudioProcessing`) use the read-modify-write pattern, which could theoretically conflict. This is an existing risk, not introduced by this spec.

## Key Files

- `packages/database/types/metadata.ts` - VideoMetadata type; adds `transcriptionStartedAt` field for PROCESSING staleness tracking
- `apps/web/app/api/upload/[...route]/multipart.ts` - Upload completion endpoint; adds transcribeVideo fire-and-forget call (without forced AI generation) after both upload paths
- `apps/web/lib/transcribe.ts` - Transcription entry point; PROCESSING timeout uses metadata timestamp instead of updatedAt, removed videoUploads phase guard
- `apps/web/workflows/transcribe.ts` - Transcription workflow; raw-upload.webm candidate with headObject probes, JSON_SET for transcriptionStartedAt, extractAudio returns audioKey, cleanupTempAudio in finally block
