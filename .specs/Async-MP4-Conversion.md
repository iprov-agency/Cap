---
created: 2026-04-08
system: cap
status: draft
target_agent: worktree
acceptance_criteria:
  - "Does the multipart /complete endpoint skip startVideoProcessingWorkflow() for raw recorder uploads?"
  - "Does the raw recorder upload path update the videoUploads record to phase 'complete' with rawFileKey preserved?"
  - "Does the startVideoProcessingWorkflow import no longer appear in multipart.ts?"
  - "Does getDownloadInfo still return a download URL for videos without result.mp4 (falling back to the raw file)?"
depends_on:
  - Transcription-Decouple
supersedes:
repos:
  - Cap
---

# Async MP4 Conversion

## Problem

The media-server converts every webm to mp4 immediately after upload via `startVideoProcessingWorkflow()` in the multipart `/complete` endpoint. This is slow, blocks other operations, and fails on R2 writes (403 Forbidden). Most users watch the video in the browser where webm plays natively. The conversion is unnecessary on the critical upload path.

## Design

Remove the `startVideoProcessingWorkflow()` call from the raw recorder upload path in the multipart `/complete` endpoint. Instead, clean up the `videoUploads` record immediately after saving video metadata, since there is no processing phase to track.

The existing download infrastructure already handles the missing-mp4 case. `getDownloadInfo` in `packages/web-backend/src/Videos/index.ts` (lines 479-537) checks `headObject` for `result.mp4`. When it does not exist, it falls back to the `rawFileKey` from the `videoUploads` table. Since this spec deletes the upload record after completion, the download fallback also needs the raw file key preserved somewhere. The raw file key follows a deterministic pattern (`{ownerId}/{videoId}/raw-upload.{ext}`), but the `getDownloadInfo` method queries `videoUploads.rawFileKey` to find it. After deleting the upload record, that lookup returns nothing.

To handle this, the raw recorder upload path stores the `rawFileKey` on the upload record before deleting it. But wait: the upload record IS deleted. The fallback in `getDownloadInfo` only triggers for `webMP4` source type, and it checks both `headObject(result.mp4)` and `videoUploads.rawFileKey`. Since we are deleting the upload record, neither path would return a URL. The raw webm IS the video. The fix: instead of deleting the upload record entirely, update it to phase "complete" and preserve the rawFileKey so `getDownloadInfo` can find it.

Actually, re-reading `getDownloadInfo` more carefully: when `headObject(result.mp4)` returns nothing (Option.isNone), it queries `videoUploads` for `rawFileKey`. If that exists, it returns a signed URL for the raw file. So the upload record must remain with the `rawFileKey` populated. The cleanest approach: update the upload record to phase "complete" with the rawFileKey set, rather than deleting it.

### Bug Fixes (from adversarial review)

Four bugs identified by Codex adversarial review are fixed in this revision:

**F1 (HIGH): Raw recorder uploads misclassified when fileKey is used.** `getSubpath` returns `undefined` for fileKey inputs, so `subpath` defaults to `"result.mp4"`. This makes `isRawRecorderUpload` false even for raw uploads using the deprecated fileKey input. Fix: derive subpath from fileKey when present via `fileKey.split("/").slice(2).join("/")`.

**F2 (medium): Raw completion does not guarantee a videoUploads row exists.** The raw recorder branch only calls `update` (no insert). If the row is missing, `rawFileKey` is never stored. Fix: use upsert (`insert` with `onDuplicateKeyUpdate`) instead of plain `update` for the videoUploads record on raw completion.

**F3 (medium): Transactions not actually used for paired updates.** `db.transaction(() => ...)` ignores the tx parameter. Queries run on outer db, not the transaction. Fix: use the transaction handle `db.transaction(async (tx) => { tx.update(...); tx.delete(...); })`.

**F4 (low): Stale processing error/message persist after completion.** Setting `phase: "complete"` does not clear `processingError` or `processingMessage`. Fix: add `processingError: null` and `processingMessage: null` when setting phase to "complete".

### Changes

1. **`apps/web/app/api/upload/[...route]/multipart.ts`**: In the `isRawRecorderUpload(subpath)` block, replace the `startVideoProcessingWorkflow()` call with an upsert to the `videoUploads` record: set phase to "complete", rawFileKey to the uploaded file key, and clear processingError/processingMessage. Remove the `startVideoProcessingWorkflow` import since no code path in this file uses it anymore. Fix subpath derivation for fileKey inputs. Fix both transaction blocks to use the transaction handle.

That is the only file that changes. The download infrastructure, share page, and CapCard download all work without modification because `getDownloadInfo` already has the raw file fallback logic.

### What still works

- **Playback**: The share page resolves video source via `playback-source.ts`, which returns the raw webm URL. Browsers play webm natively.
- **Download from dashboard**: `VideoGetDownloadInfo` RPC calls `getDownloadInfo`, which checks `headObject(result.mp4)`, finds nothing, queries `videoUploads.rawFileKey`, and returns a signed URL for the raw webm.
- **Download from share page**: The media player download button downloads `currentSrc`, which is the raw webm URL. Works without conversion.
- **Transcription**: Unaffected. The Transcription-Decouple spec fires `transcribeVideo()` after both upload paths complete, independent of processing.
- **Desktop MP4 uploads**: Unaffected. Desktop uploads use `desktopMP4` source type and upload directly to `result.mp4`, so `isRawRecorderUpload` is false for those paths.
- **Manual processing**: `triggerVideoProcessing` and `retryVideoProcessing` server actions remain available if a future UI needs on-demand conversion.

## Acceptance Criteria

- [ ] Does the multipart /complete endpoint skip startVideoProcessingWorkflow() for raw recorder uploads?
- [ ] Does the raw recorder upload path update the videoUploads record to phase "complete" with rawFileKey preserved?
- [ ] Does the startVideoProcessingWorkflow import no longer appear in multipart.ts?
- [ ] Does getDownloadInfo still return a download URL for videos without result.mp4 (falling back to the raw file)?

## Implementation

### `apps/web/app/api/upload/[...route]/multipart.ts`

This file is based on the current main branch. The changes are: (1) remove the `startVideoProcessingWorkflow` import, (2) derive subpath from fileKey when present (F1), (3) replace the `startVideoProcessingWorkflow` call in the raw recorder upload block with an upsert that sets phase "complete", rawFileKey, and clears processingError/processingMessage (F2, F4), (4) fix both transaction blocks to use the transaction handle (F3).

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
		z
			.object({ contentType: z.string() })
			.and(
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

		let uploadSucceeded = false;

		const response = await Effect.gen(function* () {
			const repo = yield* VideosRepo;
			const policy = yield* VideosPolicy;
			const db = yield* Database;

			const subpathFromFileKey = fileKey.split("/").slice(2).join("/");
			const subpath = getSubpath(body) ?? subpathFromFileKey ?? "result.mp4";

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
							db.transaction(async (tx) => {
								await tx
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
									);
								await tx
									.insert(Db.videoUploads)
									.values({
										videoId: Video.VideoId.make(videoId),
										phase: "complete",
										rawFileKey: fileKey,
										processingProgress: 100,
										processingError: null,
										processingMessage: null,
									})
									.onDuplicateKeyUpdate({
										set: {
											phase: "complete",
											rawFileKey: fileKey,
											processingProgress: 100,
											processingError: null,
											processingMessage: null,
											updatedAt: new Date(),
										},
									});
							}),
						);

						uploadSucceeded = true;

						return c.json({
							location: result.Location,
							success: true,
							fileKey,
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
						db.transaction(async (tx) => {
							await tx
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
								);
							await tx
								.delete(Db.videoUploads)
								.where(
									eq(Db.videoUploads.videoId, Video.VideoId.make(videoId)),
								);
						}),
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

					uploadSucceeded = true;

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

		if (videoIdRaw && uploadSucceeded) {
			transcribeVideo(Video.VideoId.make(videoIdRaw), user.id).catch((err) => {
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

## Open Questions

- Should the "complete" phase on the videoUploads record eventually be cleaned up by a background job? Currently, completed upload records persist indefinitely so `getDownloadInfo` can find the rawFileKey. This is fine for now since the record is small, but a future spec could add a TTL-based cleanup.
- When on-demand MP4 conversion is desired in the future, should it be triggered from the download flow (`getDownloadInfo`) or from a separate dedicated endpoint? The existing `triggerVideoProcessing` server action is already wired up for this. A follow-up spec could add a "Convert to MP4" button to the dashboard or share page that calls this action.

## Key Files

- `apps/web/app/api/upload/[...route]/multipart.ts` - Removed startVideoProcessingWorkflow call from raw recorder upload path, replaced with videoUploads upsert to phase "complete" with rawFileKey preserved. Fixed fileKey subpath derivation, transaction handle usage, and stale processing fields.
- `apps/web/app/api/upload/[...route]/multipart-utils.ts` - Unchanged. getSubpath still returns undefined for fileKey inputs; the fix is in the calling code.
- `packages/web-backend/src/Videos/index.ts` - Unchanged. getDownloadInfo already handles missing result.mp4 by falling back to videoUploads.rawFileKey
- `apps/web/lib/video-processing.ts` - Unchanged. startVideoProcessingWorkflow still exists for use by trigger-processing and retry-processing actions
- `apps/web/actions/video/trigger-processing.ts` - Unchanged. Available for future on-demand conversion UI
- `apps/web/actions/video/retry-processing.ts` - Unchanged. Available for future on-demand conversion UI
