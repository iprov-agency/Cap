---
created: 2026-04-10
system: cap
status: draft
target_agent: worktree
acceptance_criteria:
  - "multipart.ts imports startVideoProcessingWorkflow from @/lib/video-processing"
  - "multipart.ts calls startVideoProcessingWorkflow after upload succeeds for raw recorder uploads, fire-and-forget with .catch() error handling"
  - "CapVideoPlayer.tsx showRawPlaybackBadge condition includes hasActiveProgress so the badge only renders during active processing"
  - "layout.tsx manifest link href includes a cache-busting query parameter"
  - "No TypeScript any types or code comments are introduced"
  - "Existing transcribeVideo call and isRawRecorderUpload phase-setting logic are unchanged"
depends_on:
supersedes:
repos:
  - Cap
---

# Cap Web Recording Pipeline Fixes

## Problem

Three broken behaviors in Cap's web recording pipeline: (1) Web recordings uploaded via multipart never get converted from WebM to MP4 because `startVideoProcessingWorkflow` is never called after upload completes. (2) The "Optimizing video" badge shows permanently for all owner-viewed videos using raw source, even when no processing is active. (3) The `site.webmanifest` serves a stale cached version because browsers and CDN proxies cache the manifest URL without a versioning parameter.

## Design

Three targeted fixes, each isolated to a single file with no cross-dependencies.

### Fix 1: Trigger video processing after raw recorder upload

In `multipart.ts`, the `/complete` handler already sets the `videoUploads` phase to `"complete"` with `rawFileKey` preserved when `isRawRecorderUpload(subpath)` is true. But it never kicks off the actual WebM-to-MP4 conversion. The fix adds a fire-and-forget call to `startVideoProcessingWorkflow` after the upload succeeds (alongside the existing `transcribeVideo` call).

Since `startVideoProcessingWorkflow` handles its own phase transitions internally (sets to `"processing"`, then the webhook handler sets to `"complete"` on finish), this does not conflict with the existing phase-setting in the `isRawRecorderUpload` block.

To pass the required data (`isRawUpload` flag, `bucketId`, `fileKey`) from inside the Effect block to the post-upload code, two variables are hoisted alongside the existing `uploadSucceeded` flag: `isRawUpload` and `uploadBucketId`.

### Fix 2: Gate badge on active processing

In `CapVideoPlayer.tsx`, `showRawPlaybackBadge` currently only checks `showPlaybackStatusBadge && resolvedSrc.data?.type === "raw"`. The fix adds `&& hasActiveProgress` so the badge only renders when there is a genuine active upload/processing phase, not just when the source falls back to raw.

### Fix 3: Cache-bust the manifest link

In `layout.tsx`, the manifest `<link>` tag gets a `?v=2` query parameter to force browsers and CDN proxies to fetch the fresh version.

## Acceptance Criteria

- [ ] `multipart.ts` imports `startVideoProcessingWorkflow` from `@/lib/video-processing`
- [ ] `multipart.ts` calls `startVideoProcessingWorkflow` after upload succeeds for raw recorder uploads, fire-and-forget with `.catch()` error handling
- [ ] `CapVideoPlayer.tsx` `showRawPlaybackBadge` condition includes `hasActiveProgress` so the badge only renders during active processing
- [ ] `layout.tsx` manifest link href includes a cache-busting query parameter
- [ ] No TypeScript `any` types or code comments are introduced
- [ ] Existing `transcribeVideo` call and `isRawRecorderUpload` phase-setting logic are unchanged

## Implementation

### `apps/web/app/api/upload/[...route]/multipart.ts`

Added import of `startVideoProcessingWorkflow`. Added `isRawUpload` and `uploadBucketId` hoisted variables. Set them inside the `isRawRecorderUpload` block. Added fire-and-forget call to `startVideoProcessingWorkflow` after the existing `transcribeVideo` call.

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
		let isRawUpload = false;
		let uploadBucketId: string | null = null;

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

						isRawUpload = true;
						uploadBucketId = video.bucketId;
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

			if (isRawUpload) {
				startVideoProcessingWorkflow({
					videoId: Video.VideoId.make(videoIdRaw),
					userId: user.id,
					rawFileKey: fileKey,
					bucketId: uploadBucketId,
					processingMessage: "Processing uploaded recording",
					startFailureMessage: "Failed to start video processing",
					mode: "multipart",
				}).catch((err) => {
					console.error(
						`[multipart] Video processing trigger failed for ${videoIdRaw}:`,
						err,
					);
				});
			}
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

### `apps/web/app/s/[videoId]/_components/CapVideoPlayer.tsx`

Changed `showRawPlaybackBadge` condition to include `hasActiveProgress`, so the badge only renders when there is a genuine active upload/processing phase.

```tsx
"use client";

import { LogoSpinner } from "@cap/ui";
import { calculateStrokeDashoffset, getProgressCircleConfig } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { faPlay } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangleIcon, InfoIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { retryVideoProcessing } from "@/actions/video/retry-processing";
import CommentStamp from "./CommentStamp";
import {
	canRetryFailedProcessing,
	getUploadFailureMessage,
	shouldDeferPlaybackSource,
	shouldReloadPlaybackAfterUploadCompletes,
	useUploadProgress,
} from "./ProgressCircle";
import {
	isSourcePotentiallyStale,
	type ResolvedPlaybackSource,
	resolvePlaybackSource,
	shouldFallbackToRawPlaybackSource,
} from "./playback-source";
import {
	MediaPlayer,
	MediaPlayerCaptions,
	MediaPlayerControls,
	MediaPlayerControlsOverlay,
	MediaPlayerError,
	MediaPlayerFullscreen,
	MediaPlayerLoading,
	MediaPlayerPiP,
	MediaPlayerPlay,
	MediaPlayerSeek,
	MediaPlayerSeekBackward,
	MediaPlayerSeekForward,
	MediaPlayerSettings,
	MediaPlayerTime,
	MediaPlayerVideo,
	MediaPlayerVolume,
	MediaPlayerVolumeIndicator,
} from "./video/media-player";
import { Tooltip, TooltipContent, TooltipTrigger } from "./video/tooltip";

const { circumference } = getProgressCircleConfig();

const PLACEHOLDER_SVG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="224" height="128"><rect fill="%231f2937" width="224" height="128"/></svg>')}`;

const ERROR_SVG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="224" height="128"><rect fill="%23dc2626" width="224" height="128"/></svg>')}`;

function getProgressStatusText(
	status: "uploading" | "processing" | "generating_thumbnail",
) {
	switch (status) {
		case "processing":
			return "Processing";
		case "generating_thumbnail":
			return "Finishing up";
		default:
			return "Uploading";
	}
}

type EnhancedAudioStatus = "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";

interface CaptionOption {
	code: string;
	name: string;
}

interface Props {
	videoSrc: string;
	rawFallbackSrc?: string;
	videoId: Video.VideoId;
	chaptersSrc: string;
	captionsSrc: string;
	disableCaptions?: boolean;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	mediaPlayerClassName?: string;
	autoplay?: boolean;
	enableCrossOrigin?: boolean;
	hasActiveUpload: boolean | undefined;
	disableCommentStamps?: boolean;
	disableReactionStamps?: boolean;
	comments?: Array<{
		id: string;
		timestamp: number | null;
		type: "text" | "emoji";
		content: string;
		authorName?: string | null;
	}>;
	onSeek?: (time: number) => void;
	enhancedAudioUrl?: string | null;
	enhancedAudioStatus?: EnhancedAudioStatus | null;
	captionLanguage?: string;
	onCaptionLanguageChange?: (language: string) => void;
	availableCaptions?: CaptionOption[];
	isCaptionLoading?: boolean;
	hasCaptions?: boolean;
	canRetryProcessing?: boolean;
	duration?: number | null;
	showPlaybackStatusBadge?: boolean;
}

export function CapVideoPlayer({
	videoSrc,
	rawFallbackSrc,
	videoId,
	chaptersSrc,
	captionsSrc,
	disableCaptions,
	videoRef,
	mediaPlayerClassName,
	autoplay = false,
	enableCrossOrigin = false,
	hasActiveUpload,
	comments = [],
	disableCommentStamps = false,
	disableReactionStamps = false,
	onSeek,
	enhancedAudioUrl: _enhancedAudioUrl,
	enhancedAudioStatus: _enhancedAudioStatus,
	captionLanguage,
	onCaptionLanguageChange,
	availableCaptions = [],
	isCaptionLoading = false,
	hasCaptions = false,
	canRetryProcessing = false,
	duration: fallbackDuration,
	showPlaybackStatusBadge = false,
}: Props) {
	const [currentCue, setCurrentCue] = useState<string>("");
	const [controlsVisible, setControlsVisible] = useState(false);
	const [mainControlsVisible, setMainControlsVisible] = useState(false);
	const [toggleCaptions, setToggleCaptions] = useState(true);
	const [showPlayButton, setShowPlayButton] = useState(false);
	const [videoLoaded, setVideoLoaded] = useState(false);
	const [hasPlayedOnce, setHasPlayedOnce] = useState(false);
	const [isMobile, setIsMobile] = useState(false);
	const [hasError, setHasError] = useState(false);
	const [autoRetryCount, setAutoRetryCount] = useState(0);
	const [isRetryingProcessing, setIsRetryingProcessing] = useState(false);
	const [playerDuration, setPlayerDuration] = useState(fallbackDuration ?? 0);
	const [preferredSource, setPreferredSource] = useState<"mp4" | "raw">("mp4");
	const [hasTriedRawFallback, setHasTriedRawFallback] = useState(false);
	const [hasTriedRefresh, setHasTriedRefresh] = useState(false);
	const queryClient = useQueryClient();

	const previewVideoRef = useRef<HTMLVideoElement>(null);
	const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const scrubThumbnailRef = useRef<{
		time: number;
		src: string;
		videoUrl: string;
	} | null>(null);
	const pendingPreviewSeekRef = useRef<number | null>(null);
	const isMountedRef = useRef(true);
	const [, setScrubThumbnailVersion] = useState(0);

	useEffect(() => {
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		const checkMobile = () => {
			setIsMobile(window.innerWidth < 640);
		};

		checkMobile();
		window.addEventListener("resize", checkMobile);

		return () => window.removeEventListener("resize", checkMobile);
	}, []);

	const uploadProgressRaw = useUploadProgress(
		videoId,
		hasActiveUpload || false,
	);
	const uploadProgress = videoLoaded ? null : uploadProgressRaw;
	const isUploading = uploadProgress?.status === "uploading";
	const isProcessing = uploadProgress?.status === "processing";
	const isGeneratingThumbnail =
		uploadProgress?.status === "generating_thumbnail";
	const hasActiveProgress =
		isUploading || isProcessing || isGeneratingThumbnail;
	const shouldDeferResolvedSource = shouldDeferPlaybackSource(uploadProgress);

	const resolvedSrc = useQuery<ResolvedPlaybackSource | null>({
		queryKey: [
			"resolvedSrc",
			videoSrc,
			rawFallbackSrc,
			enableCrossOrigin,
			preferredSource,
		],
		queryFn: shouldDeferResolvedSource
			? skipToken
			: () =>
					resolvePlaybackSource({
						videoSrc,
						rawFallbackSrc,
						enableCrossOrigin,
						preferredSource,
					}),
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});

	useEffect(() => {
		void videoSrc;
		void rawFallbackSrc;
		setVideoLoaded(false);
		setHasError(false);
		setShowPlayButton(false);
		setPreferredSource("mp4");
		setHasTriedRawFallback(false);
		setHasTriedRefresh(false);
	}, [videoSrc, rawFallbackSrc]);

	const prevResolvedAtRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		const currentResolvedAt = resolvedSrc.data?.resolvedAt;
		if (
			currentResolvedAt !== undefined &&
			prevResolvedAtRef.current !== undefined &&
			currentResolvedAt !== prevResolvedAtRef.current &&
			resolvedSrc.data?.type === "mp4" &&
			!isSourcePotentiallyStale(resolvedSrc.data)
		) {
			setHasTriedRefresh(false);
		}
		prevResolvedAtRef.current = currentResolvedAt;
	}, [resolvedSrc.data?.resolvedAt, resolvedSrc.data?.type, resolvedSrc.data]);

	useEffect(() => {
		setPlayerDuration(fallbackDuration ?? 0);
	}, [fallbackDuration]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;

		const handleLoadedMetadata = () => {
			if (Number.isFinite(video.duration) && video.duration > 0) {
				setPlayerDuration(video.duration);
			}
		};

		if (Number.isFinite(video.duration) && video.duration > 0) {
			setPlayerDuration(video.duration);
		}

		video.addEventListener("loadedmetadata", handleLoadedMetadata);

		return () => {
			video.removeEventListener("loadedmetadata", handleLoadedMetadata);
		};
	}, [videoRef]);

	const [markersReady, setMarkersReady] = useState(false);
	const [hoveredComment, setHoveredComment] = useState<string | null>(null);

	const handleMouseEnter = useCallback((commentId: string) => {
		setHoveredComment(commentId);
	}, []);

	const handleMouseLeave = useCallback(() => {
		setHoveredComment(null);
	}, []);

	useEffect(() => {
		if (playerDuration > 0 && comments.length > 0 && videoRef.current) {
			setMarkersReady(true);
		}
	}, [playerDuration, comments.length, videoRef.current]);

	useEffect(() => {
		if (resolvedSrc.data) {
			setHasError(false);
			setAutoRetryCount(0);
			return;
		}

		if (uploadProgress || resolvedSrc.isPending) {
			setHasError(false);
			return;
		}

		if (resolvedSrc.isSuccess) {
			setHasError(true);
		}
	}, [
		resolvedSrc.data,
		resolvedSrc.isPending,
		resolvedSrc.isSuccess,
		uploadProgress,
	]);

	useEffect(() => {
		if (!hasError || autoRetryCount >= 5) return;

		const timer = setTimeout(() => {
			setAutoRetryCount((c) => c + 1);
			setHasError(false);
			setVideoLoaded(false);
			setHasTriedRawFallback(false);
			setHasTriedRefresh(false);
			setPreferredSource("mp4");
			queryClient.invalidateQueries({
				queryKey: ["resolvedSrc"],
			});
		}, 3000);

		return () => clearTimeout(timer);
	}, [hasError, autoRetryCount, queryClient]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || resolvedSrc.isPending) return;

		const handleLoadedData = () => {
			setVideoLoaded(true);
			setHasError(false);
			if (!hasPlayedOnce) {
				setShowPlayButton(true);
			}
		};

		const handleCanPlay = () => {
			setVideoLoaded(true);
			setHasError(false);
			if (!hasPlayedOnce) {
				setShowPlayButton(true);
			}
		};

		const handlePlay = () => {
			setHasPlayedOnce(true);
		};

		const handleError = () => {
			const sourceIsStale = isSourcePotentiallyStale(resolvedSrc.data);

			if (
				resolvedSrc.data?.type === "mp4" &&
				sourceIsStale &&
				!hasTriedRefresh
			) {
				setHasTriedRefresh(true);
				setVideoLoaded(false);
				setHasError(false);
				setShowPlayButton(false);
				queryClient.invalidateQueries({
					queryKey: [
						"resolvedSrc",
						videoSrc,
						rawFallbackSrc,
						enableCrossOrigin,
						preferredSource,
					],
				});
				return;
			}

			if (
				shouldFallbackToRawPlaybackSource(
					resolvedSrc.data?.type,
					rawFallbackSrc,
					hasTriedRawFallback,
				)
			) {
				setHasTriedRawFallback(true);
				setPreferredSource("raw");
				setVideoLoaded(false);
				setHasError(false);
				setShowPlayButton(false);
				return;
			}

			setHasError(true);
		};

		let captionTrack: TextTrack | null = null;

		const handleCueChange = (): void => {
			if (captionTrack?.activeCues && captionTrack.activeCues.length > 0) {
				const cue = captionTrack.activeCues[0] as VTTCue;
				const plainText = cue.text.replace(/<[^>]*>/g, "");
				setCurrentCue(plainText);
			} else {
				setCurrentCue("");
			}
		};

		const setupTracks = (): void => {
			const tracks = Array.from(video.textTracks);

			for (const track of tracks) {
				if (track.kind === "captions" || track.kind === "subtitles") {
					captionTrack = track;
					track.mode = "hidden";
					track.addEventListener("cuechange", handleCueChange);
					break;
				}
			}
		};

		const ensureTracksHidden = (): void => {
			const tracks = Array.from(video.textTracks);
			for (const track of tracks) {
				if (track.kind === "captions" || track.kind === "subtitles") {
					if (track.mode !== "hidden") {
						track.mode = "hidden";
					}
				}
			}
		};

		const handleLoadedMetadataWithTracks = () => {
			setVideoLoaded(true);
			setHasError(false);
			if (!hasPlayedOnce) {
				setShowPlayButton(true);
			}
			setupTracks();
		};

		const handleTrackChange = () => {
			ensureTracksHidden();
			setupTracks();
		};

		video.addEventListener("loadeddata", handleLoadedData);
		video.addEventListener("canplay", handleCanPlay);
		video.addEventListener("loadedmetadata", handleLoadedMetadataWithTracks);
		video.addEventListener("play", handlePlay);
		video.addEventListener("error", handleError as EventListener);

		video.textTracks.addEventListener("change", handleTrackChange);
		video.textTracks.addEventListener("addtrack", handleTrackChange);
		video.textTracks.addEventListener("removetrack", handleTrackChange);

		if (video.readyState === 4) {
			handleLoadedData();
		}

		return () => {
			video.removeEventListener("loadeddata", handleLoadedData);
			video.removeEventListener("canplay", handleCanPlay);
			video.removeEventListener("play", handlePlay);
			video.removeEventListener("error", handleError as EventListener);
			video.removeEventListener(
				"loadedmetadata",
				handleLoadedMetadataWithTracks,
			);
			video.textTracks.removeEventListener("change", handleTrackChange);
			video.textTracks.removeEventListener("addtrack", handleTrackChange);
			video.textTracks.removeEventListener("removetrack", handleTrackChange);
			if (captionTrack) {
				captionTrack.removeEventListener("cuechange", handleCueChange);
			}
		};
	}, [
		enableCrossOrigin,
		hasPlayedOnce,
		hasTriedRawFallback,
		hasTriedRefresh,
		preferredSource,
		queryClient,
		rawFallbackSrc,
		resolvedSrc.data,
		resolvedSrc.isPending,
		videoRef.current,
		videoSrc,
	]);

	const generateVideoFrameThumbnail = useCallback(
		(time: number): string => {
			const currentVideoUrl = resolvedSrc.data?.url ?? "";
			const cached = scrubThumbnailRef.current;
			if (
				cached &&
				Math.abs(cached.time - time) < 0.01 &&
				cached.videoUrl === currentVideoUrl
			) {
				return cached.src;
			}

			const preview = previewVideoRef.current;
			if (!preview || preview.readyState < 1) {
				return PLACEHOLDER_SVG;
			}

			if (
				pendingPreviewSeekRef.current !== null &&
				Math.abs(pendingPreviewSeekRef.current - time) < 0.01
			) {
				if (cached && cached.videoUrl === currentVideoUrl) {
					return cached.src;
				}
				return PLACEHOLDER_SVG;
			}

			pendingPreviewSeekRef.current = time;

			const seekAndCapture = () => {
				const cleanup = () => {
					clearTimeout(seekTimeout);
					preview.removeEventListener("seeked", onSeeked);
					preview.removeEventListener("error", onError);
				};

				const onSeeked = () => {
					cleanup();

					if (!isMountedRef.current) return;

					if (!previewCanvasRef.current) {
						previewCanvasRef.current = document.createElement("canvas");
					}
					const canvas = previewCanvasRef.current;
					canvas.width = 224;
					canvas.height = 128;
					const ctx = canvas.getContext("2d");

					if (ctx) {
						try {
							ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);
							const src = canvas.toDataURL("image/jpeg", 0.8);
							scrubThumbnailRef.current = {
								time,
								src,
								videoUrl: currentVideoUrl,
							};
						} catch (_e) {
							scrubThumbnailRef.current = {
								time,
								src: ERROR_SVG,
								videoUrl: currentVideoUrl,
							};
						}
					}

					pendingPreviewSeekRef.current = null;
					setScrubThumbnailVersion((v) => v + 1);
				};

				const onError = () => {
					cleanup();
					pendingPreviewSeekRef.current = null;
				};

				const seekTimeout = setTimeout(() => {
					preview.removeEventListener("seeked", onSeeked);
					preview.removeEventListener("error", onError);
					pendingPreviewSeekRef.current = null;
				}, 3000);

				preview.addEventListener("seeked", onSeeked, { once: true });
				preview.addEventListener("error", onError, { once: true });
				const safeTime = Math.min(Math.max(time, 0), preview.duration || time);
				preview.currentTime = safeTime;
			};

			seekAndCapture();

			if (cached && cached.videoUrl === currentVideoUrl) {
				return cached.src;
			}
			return PLACEHOLDER_SVG;
		},
		[resolvedSrc.data?.url],
	);

	const isUploadFailed = uploadProgress?.status === "failed";
	const isUploadError = uploadProgress?.status === "error";
	const showUploadFailureOverlay =
		isUploadFailed ||
		(isUploadError && !resolvedSrc.data && !resolvedSrc.isPending);
	const canRetryUploadProcessing = canRetryFailedProcessing(
		uploadProgress,
		canRetryProcessing,
	);
	const uploadFailureMessage = getUploadFailureMessage(
		uploadProgress,
		canRetryProcessing,
	);

	const retryProcessing = useCallback(async () => {
		if (!canRetryUploadProcessing || isRetryingProcessing) {
			return;
		}

		setIsRetryingProcessing(true);

		try {
			const result = await retryVideoProcessing({ videoId });
			await queryClient.invalidateQueries({
				queryKey: ["getUploadProgress", videoId],
			});
			toast.success(
				result.status === "started"
					? "Video processing restarted."
					: "Video is still processing.",
			);
		} catch (error) {
			console.error("Failed to retry video processing", error);
			toast.error("Could not retry video processing.");
		} finally {
			setIsRetryingProcessing(false);
		}
	}, [canRetryUploadProcessing, isRetryingProcessing, queryClient, videoId]);

	const prevUploadProgress = useRef<typeof uploadProgress>(uploadProgress);
	useEffect(() => {
		if (
			shouldReloadPlaybackAfterUploadCompletes(
				prevUploadProgress.current,
				uploadProgress,
				videoLoaded,
			)
		) {
			setHasError(false);
			void queryClient.invalidateQueries({
				queryKey: [
					"resolvedSrc",
					videoSrc,
					rawFallbackSrc,
					enableCrossOrigin,
					preferredSource,
				],
			});
		}
		prevUploadProgress.current = uploadProgress;
	}, [
		enableCrossOrigin,
		preferredSource,
		queryClient,
		rawFallbackSrc,
		uploadProgress,
		videoLoaded,
		videoSrc,
	]);

	const isAutoRetrying = hasError && autoRetryCount < 5;
	const showPreparingOverlay =
		!videoLoaded &&
		!uploadProgress &&
		(!hasError || isAutoRetrying) &&
		(!resolvedSrc.isSuccess || Boolean(resolvedSrc.data));
	const showPlaybackResolutionError =
		hasError &&
		!isAutoRetrying &&
		!uploadProgress &&
		!resolvedSrc.data &&
		!resolvedSrc.isPending;
	const showRawPlaybackBadge =
		showPlaybackStatusBadge &&
		resolvedSrc.data?.type === "raw" &&
		hasActiveProgress;
	const rawPlaybackBadgeLabel =
		uploadProgressRaw?.status === "error"
			? "Original upload"
			: "Optimizing video";
	const rawPlaybackBadgeDescription =
		uploadProgressRaw?.status === "error"
			? "The processed version is unavailable right now, so this page is playing the original uploaded file instead."
			: "This page is temporarily playing the original uploaded file while Cap finishes processing the optimized version for smoother playback and broader compatibility.";
	const blockPlaybackControls =
		(!videoLoaded && hasActiveProgress) || showUploadFailureOverlay;

	return (
		<MediaPlayer
			onMouseEnter={() => setControlsVisible(true)}
			onMouseLeave={() => setControlsVisible(false)}
			onTouchStart={() => setControlsVisible(true)}
			onTouchEnd={() => setControlsVisible(false)}
			className={clsx(
				mediaPlayerClassName,
				"[&::-webkit-media-text-track-display]:!hidden",
			)}
			autoHide
		>
			{showUploadFailureOverlay && (
				<div className="flex absolute inset-0 flex-col px-3 gap-3 z-[20] justify-center items-center bg-black transition-opacity duration-300">
					<AlertTriangleIcon className="text-red-500 size-12" />
					<p className="text-gray-11 text-sm leading-relaxed text-center text-balance w-full max-w-[340px] mx-auto">
						{uploadFailureMessage}
					</p>
					{canRetryUploadProcessing && (
						<button
							type="button"
							onClick={retryProcessing}
							disabled={isRetryingProcessing}
							className="px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed hover:bg-blue-600"
						>
							{isRetryingProcessing ? "Retrying..." : "Retry Processing"}
						</button>
					)}
				</div>
			)}
			{showPlaybackResolutionError && (
				<div className="flex absolute inset-0 flex-col px-3 gap-3 z-[20] justify-center items-center bg-black transition-opacity duration-300">
					<AlertTriangleIcon className="text-red-500 size-12" />
					<p className="text-gray-11 text-sm leading-relaxed text-center text-balance w-full max-w-[340px] mx-auto">
						Could not load a playable video source. Reload to try again.
					</p>
				</div>
			)}
			<div
				className={clsx(
					"flex absolute inset-0 z-10 rounded-xl justify-center items-center bg-black transition-opacity duration-300 overflow-visible",
					videoLoaded || !!uploadProgress || !showPreparingOverlay
						? "opacity-0 pointer-events-none"
						: "opacity-100",
				)}
			>
				<div className="flex flex-col gap-2 items-center">
					<LogoSpinner className="w-8 h-auto animate-spin sm:w-10" />
				</div>
			</div>
			{showRawPlaybackBadge && (
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							className="absolute top-3 left-3 z-10 inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur-sm transition-colors hover:bg-black/70"
							aria-label={rawPlaybackBadgeDescription}
						>
							<InfoIcon className="size-3" />
							<span>{rawPlaybackBadgeLabel}</span>
						</button>
					</TooltipTrigger>
					<TooltipContent
						side="bottom"
						align="start"
						className="max-w-[260px] border border-white/10 bg-black/90 px-3 py-2 text-xs leading-relaxed text-white shadow-xl"
					>
						{rawPlaybackBadgeDescription}
					</TooltipContent>
				</Tooltip>
			)}
			{resolvedSrc.data && (
				<MediaPlayerVideo
					src={resolvedSrc.data.url}
					ref={videoRef}
					onLoadedData={() => {
						setVideoLoaded(true);
					}}
					onPlay={() => {
						setShowPlayButton(false);
						setHasPlayedOnce(true);
					}}
					crossOrigin={
						resolvedSrc.data.supportsCrossOrigin ? "anonymous" : undefined
					}
					playsInline
					autoPlay={autoplay}
				>
					{chaptersSrc && <track default kind="chapters" src={chaptersSrc} />}
					{captionsSrc && (
						<track
							label="English"
							kind="captions"
							srcLang="en"
							src={captionsSrc}
						/>
					)}
				</MediaPlayerVideo>
			)}
			{resolvedSrc.data && (
				<video
					ref={previewVideoRef}
					src={resolvedSrc.data.url}
					crossOrigin={
						resolvedSrc.data.supportsCrossOrigin ? "anonymous" : undefined
					}
					preload="metadata"
					muted
					playsInline
					style={{ display: "none" }}
				>
					<track kind="captions" />
				</video>
			)}
			<AnimatePresence>
				{!videoLoaded && hasActiveProgress && !showUploadFailureOverlay && (
					<>
						<motion.div
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.2 }}
							className="absolute inset-0 z-10 transition-all duration-300 bg-black/60 rounded-xl"
						/>
						<motion.div
							initial={{ opacity: 0, y: 10 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 10 }}
							transition={{ duration: 0.2 }}
							className="flex absolute bottom-3 left-3 gap-2 items-center z-20"
						>
							<span className="text-sm font-semibold text-white">
								{getProgressStatusText(
									isProcessing
										? "processing"
										: isGeneratingThumbnail
											? "generating_thumbnail"
											: "uploading",
								)}
								{uploadProgress?.progress != null &&
									uploadProgress.progress > 0 &&
									` ${Math.round(uploadProgress.progress)}%`}
							</span>
							<svg className="w-4 h-4 transform -rotate-90" viewBox="0 0 20 20">
								<title>Progress</title>
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									strokeWidth="3"
									fill="none"
									className="text-white/30"
								/>
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									strokeWidth="3"
									fill="none"
									strokeLinecap="round"
									className="text-white transition-all duration-200 ease-out"
									style={{
										strokeDasharray: `${circumference} ${circumference}`,
										strokeDashoffset: `${calculateStrokeDashoffset(uploadProgress?.progress ?? 0, circumference)}`,
									}}
								/>
							</svg>
						</motion.div>
					</>
				)}
				{showPlayButton &&
					videoLoaded &&
					!hasPlayedOnce &&
					!showUploadFailureOverlay &&
					!showPlaybackResolutionError && (
						<motion.div
							whileHover={{ scale: 1.1 }}
							whileTap={{ scale: 0.9 }}
							initial={{ opacity: 0, y: 10 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 10 }}
							transition={{ duration: 0.2 }}
							onClick={() => videoRef.current?.play()}
							className="flex absolute inset-0 z-10 justify-center items-center m-auto bg-blue-500 rounded-full transition-colors transform cursor-pointer hover:bg-blue-600 size-12 xs:size-20 md:size-32"
						>
							<FontAwesomeIcon
								icon={faPlay}
								className="text-white size-4 xs:size-8 md:size-12"
							/>
						</motion.div>
					)}
			</AnimatePresence>
			{currentCue && toggleCaptions && (
				<div
					className={clsx(
						"absolute left-1/2 transform -translate-x-1/2 text-sm sm:text-xl z-40 pointer-events-none bg-black/80 text-white px-3 sm:px-4 py-1.5 sm:py-2 rounded-md text-center transition-all duration-300 ease-in-out",
						"max-w-[90%] sm:max-w-[480px] md:max-w-[600px]",
						controlsVisible || videoRef.current?.paused
							? "bottom-16 sm:bottom-24"
							: "bottom-3 sm:bottom-12",
					)}
				>
					{currentCue}
				</div>
			)}
			<MediaPlayerLoading />
			{!isUploading &&
				!showUploadFailureOverlay &&
				!showPlaybackResolutionError && <MediaPlayerError />}
			<MediaPlayerVolumeIndicator />

			{mainControlsVisible &&
				markersReady &&
				(() => {
					const filteredComments = comments.filter(
						(comment) =>
							comment &&
							comment.timestamp !== null &&
							comment.id &&
							!(disableCommentStamps && comment.type === "text") &&
							!(disableReactionStamps && comment.type === "emoji"),
					);

					return filteredComments.map((comment) => {
						const position = (Number(comment.timestamp) / playerDuration) * 100;
						const containerPadding = 20;
						const availableWidth = `calc(100% - ${containerPadding * 2}px)`;
						const adjustedPosition = `calc(${containerPadding}px + (${position}% * ${availableWidth} / 100%))`;

						return (
							<CommentStamp
								key={comment.id}
								comment={comment}
								adjustedPosition={adjustedPosition}
								handleMouseEnter={handleMouseEnter}
								handleMouseLeave={handleMouseLeave}
								onSeek={onSeek}
								hoveredComment={hoveredComment}
							/>
						);
					});
				})()}

			<MediaPlayerControls
				className="flex-col items-start gap-2.5"
				mainControlsVisible={(arg: boolean) => setMainControlsVisible(arg)}
				isUploadingOrFailed={blockPlaybackControls}
			>
				<MediaPlayerControlsOverlay className="rounded-b-xl" />
				<MediaPlayerSeek
					fallbackDuration={playerDuration}
					tooltipThumbnailSrc={
						isMobile || !resolvedSrc.isSuccess
							? undefined
							: generateVideoFrameThumbnail
					}
				/>
				<div className="flex gap-2 items-center w-full">
					<div className="flex flex-1 gap-2 items-center">
						<MediaPlayerPlay />
						<MediaPlayerSeekBackward />
						<MediaPlayerSeekForward />
						<MediaPlayerVolume expandable />
						<MediaPlayerTime fallbackDuration={playerDuration} />
					</div>
					<div className="flex gap-2 items-center">
						{!disableCaptions && (
							<MediaPlayerCaptions
								setToggleCaptions={setToggleCaptions}
								toggleCaptions={toggleCaptions}
							/>
						)}
						<MediaPlayerSettings
							captionLanguage={captionLanguage}
							onCaptionLanguageChange={onCaptionLanguageChange}
							availableCaptions={availableCaptions}
							isCaptionLoading={isCaptionLoading}
							hasCaptions={hasCaptions}
						/>
						<MediaPlayerPiP />
						<MediaPlayerFullscreen />
					</div>
				</div>
			</MediaPlayerControls>
		</MediaPlayer>
	);
}
```

### `apps/web/app/layout.tsx`

Changed the manifest link to include a `?v=2` cache-busting query parameter.

```tsx
import "@/app/globals.css";
import { buildEnv, serverEnv } from "@cap/env";
import { STRIPE_PLAN_IDS } from "@cap/utils";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Effect } from "effect";
import type { Metadata } from "next";
import localFont from "next/font/local";
import type { PropsWithChildren } from "react";
import { SonnerToaster } from "@/components/SonnerToastProvider";
import { runPromise } from "@/lib/server";
import { getBootstrapData } from "@/utils/getBootstrapData";
import { PublicEnvContext } from "@/utils/public-env";
import { AuthContextProvider } from "./Layout/AuthContext";
import { resolveCurrentUser } from "./Layout/current-user";
import { GTag } from "./Layout/GTag";
import { MetaPixel } from "./Layout/MetaPixel";
import { PosthogIdentify } from "./Layout/PosthogIdentify";
import { PurchaseTracker } from "./Layout/PurchaseTracker";
import {
	PostHogProvider,
	ReactQueryProvider,
	SessionProvider,
} from "./Layout/providers";
import { StripeContextProvider } from "./Layout/StripeContext";
//@ts-expect-error
import { script } from "./themeScript";

const defaultFont = localFont({
	src: [
		{
			path: "../public/fonts/NeueMontreal-Bold.otf",
			weight: "700",
			style: "normal",
		},
		{
			path: "../public/fonts/NeueMontreal-Regular.otf",
			weight: "400",
			style: "normal",
		},
		{
			path: "../public/fonts/NeueMontreal-Medium.otf",
			weight: "500",
			style: "normal",
		},
		{
			path: "../public/fonts/NeueMontreal-MediumItalic.otf",
			weight: "500",
			style: "italic",
		},
		{
			path: "../public/fonts/NeueMontreal-Italic.otf",
			weight: "400",
			style: "italic",
		},
		{
			path: "../public/fonts/NeueMontreal-BoldItalic.otf",
			weight: "700",
			style: "italic",
		},
	],
});

export const metadata: Metadata = {
	title: "Cap - Beautiful screen recordings, owned by you.",
	description:
		"Cap is the open source alternative to Loom. Lightweight, powerful, and cross-platform. Record and share in seconds.",
	openGraph: {
		title: "Cap - Beautiful screen recordings, owned by you.",
		description:
			"Cap is the open source alternative to Loom. Lightweight, powerful, and cross-platform. Record and share in seconds.",
		type: "website",
		url: "https://cap.so",
		images: ["https://cap.so/og.png"],
	},
};

export const dynamic = "force-dynamic";

export default ({ children }: PropsWithChildren) =>
	Effect.gen(function* () {
		const bootstrapData = yield* Effect.promise(getBootstrapData);

		return (
			<html className={defaultFont.className} lang="en">
				<head>
					<link
						rel="apple-touch-icon"
						sizes="180x180"
						href="/apple-touch-icon.png"
					/>
					<link
						rel="icon"
						type="image/png"
						sizes="32x32"
						href="/favicon-32x32.png"
					/>
					<link
						rel="icon"
						type="image/png"
						sizes="16x16"
						href="/favicon-16x16.png"
					/>
					<link rel="manifest" href="/site.webmanifest?v=2" />
					<link rel="mask-icon" href="/safari-pinned-tab.svg" color="#5bbad5" />
					<link rel="shortcut icon" href="/favicon.ico" />
					<meta name="msapplication-TileColor" content="#da532c" />
					<meta name="theme-color" content="#ffffff" />
				</head>
				<body suppressHydrationWarning>
					<script
						dangerouslySetInnerHTML={{ __html: `(${script.toString()})()` }}
					/>
					<TooltipPrimitive.Provider>
						<PostHogProvider bootstrapData={bootstrapData}>
							<AuthContextProvider user={runPromise(resolveCurrentUser)}>
								<SessionProvider>
									<StripeContextProvider
										plans={
											serverEnv().VERCEL_ENV === "production"
												? STRIPE_PLAN_IDS.production
												: STRIPE_PLAN_IDS.development
										}
									>
										<PublicEnvContext
											value={{
												webUrl: buildEnv.NEXT_PUBLIC_WEB_URL,
												workosAuthAvailable: !!serverEnv().WORKOS_CLIENT_ID,
												googleAuthAvailable: !!serverEnv().GOOGLE_CLIENT_ID,
											}}
										>
											<ReactQueryProvider>
												<SonnerToaster />
												<main className="w-full">{children}</main>
												<PosthogIdentify />
												<MetaPixel />
												<GTag />
												<PurchaseTracker />
											</ReactQueryProvider>
										</PublicEnvContext>
									</StripeContextProvider>
								</SessionProvider>
							</AuthContextProvider>
						</PostHogProvider>
					</TooltipPrimitive.Provider>
				</body>
			</html>
		);
	}).pipe(runPromise);
```

## Open Questions

- The `startVideoProcessingWorkflow` function accepts an optional `mode` parameter. The spec passes `"multipart"` since this is the multipart upload handler. If there is a singlepart upload path that also needs this fix, it is out of scope for this spec.
- The `?v=2` cache-busting parameter is a one-time fix. If the manifest changes again in the future, the version number should be incremented. A content-hash approach would be more durable but is out of scope.

## Key Files

- `apps/web/app/api/upload/[...route]/multipart.ts` - multipart upload complete handler; adds video processing trigger
- `apps/web/app/s/[videoId]/_components/CapVideoPlayer.tsx` - video player component; fixes badge visibility condition
- `apps/web/app/layout.tsx` - root layout; cache-busts manifest link
- `apps/web/lib/video-processing.ts` - existing module providing `startVideoProcessingWorkflow` (not changed)
