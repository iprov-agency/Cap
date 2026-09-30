---
created: 2026-04-08
system: cap
status: draft
target_agent: worktree
acceptance_criteria:
  - "Does the transcription workflow update metadata.transcriptionProgress at each stage (EXTRACTING, TRANSCRIBING, SUMMARIZING)?"
  - "Does the transcription workflow save the error message to metadata.transcriptionError on failure?"
  - "Does getVideoStatus return transcriptionProgress and transcriptionError from metadata to the frontend?"
  - "Does the transcript UI show the current progress state instead of a generic spinner?"
  - "Does the failed state show the actual error message and a working retry button?"
depends_on:
supersedes:
repos:
  - Cap
---

# Transcript Progress UX

## Problem

When transcription is processing, the share page transcript tab shows a generic spinner with the text "Transcription in progress..." and nothing else. The user has no idea what stage the process is at, how long it has been running, or what went wrong if it fails. The retry button also shows a generic spinner. Error states show "Transcript not available" with no detail about the actual failure. This makes the experience opaque and frustrating, especially for longer videos where transcription can take over a minute.

## Design

Extend the existing `VideoMetadata` JSONB field with two new optional properties: `transcriptionProgress` (the current sub-stage) and `transcriptionError` (the error message on failure). The transcription workflow writes granular progress at each stage. The `getVideoStatus` server action surfaces these fields. The `Transcript.tsx` component renders stage-specific messages with an elapsed-time counter during the TRANSCRIBING stage.

### Progress States

The `transcriptionProgress` field cycles through:
- `"EXTRACTING"` - set when audio extraction begins
- `"TRANSCRIBING"` - set when the Gemini API call begins (this is the longest stage, so it shows elapsed time)
- `"SUMMARIZING"` - set when AI generation is queued after transcription completes
- Cleared (removed from metadata) when transcription completes or when status moves to a terminal state

### Error Handling

When the workflow throws, the `.catch()` handler in `lib/transcribe.ts` sets `transcriptionStatus` to `"ERROR"` and saves the error message to `metadata.transcriptionError`. The `Transcript.tsx` component displays this message in the error state. Critically, the `queueAiGeneration` call is wrapped in its own `.catch()` so a failure to enqueue AI generation does not mark the transcription itself as ERROR (TPUX-5).

### Data Flow

1. `transcribeVideoWorkflow()` updates `metadata.transcriptionProgress` at each stage
2. `lib/transcribe.ts` `.catch()` handler sets ERROR status and `metadata.transcriptionError`
3. `getVideoStatus()` reads `metadata.transcriptionProgress` and `metadata.transcriptionError` and includes them in `VideoStatusResult`
4. `Share.tsx` polls `getVideoStatus()` every 2 seconds (existing behavior), which now includes progress data
5. `Share.tsx` passes `transcriptionProgress` and `transcriptionError` down through `Sidebar` to `Transcript.tsx`
6. `Transcript.tsx` renders the appropriate stage message with elapsed time

### Codex Adversarial Fixes Applied

- **TPUX-1**: VTT parser uses auto-incrementing IDs when no explicit numeric identifier is present, preventing duplicate cue IDs.
- **TPUX-2**: Timestamp display computes total minutes from totalSeconds instead of using raw minutesStr, preventing rollover at 60 minutes.
- **TPUX-3**: ElapsedTimer guards against invalid dates (NaN) and clamps negative values to zero.
- **TPUX-4**: Progress fields fall back to `data.metadata?.transcriptionProgress` when `videoStatus` is null on first render, using nullish coalescing (`??`) instead of logical OR (`||`).
- **TPUX-5**: `queueAiGeneration` is wrapped in `.catch()` so failures do not mark transcription as ERROR.

## Acceptance Criteria

- [ ] Does the transcription workflow update metadata.transcriptionProgress at each stage (EXTRACTING, TRANSCRIBING, SUMMARIZING)?
- [ ] Does the transcription workflow save the error message to metadata.transcriptionError on failure?
- [ ] Does getVideoStatus return transcriptionProgress and transcriptionError from metadata to the frontend?
- [ ] Does the transcript UI show the current progress state instead of a generic spinner?
- [ ] Does the failed state show the actual error message and a working retry button?

## Implementation

### `packages/database/types/metadata.ts`

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
	transcriptionProgress?:
		| "EXTRACTING"
		| "TRANSCRIBING"
		| "SUMMARIZING";
	transcriptionError?: string;
	transcriptionProgressStartedAt?: string;
}

export interface SpaceMetadata {
	[key: string]: never;
}

export interface UserMetadata {
	[key: string]: never;
}
```

### `apps/web/workflows/transcribe.ts`

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
import { GEMINI_AUDIO_MODEL, getGeminiClient } from "@/lib/gemini-client";
import { startAiGeneration } from "@/lib/generate-ai";
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

async function updateTranscriptionProgress(
	videoId: string,
	progress: "EXTRACTING" | "TRANSCRIBING" | "SUMMARIZING",
): Promise<void> {
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
				transcriptionProgress: progress,
				transcriptionProgressStartedAt: new Date().toISOString(),
				transcriptionError: undefined,
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function clearTranscriptionProgress(
	videoId: string,
): Promise<void> {
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
				transcriptionProgress: undefined,
				transcriptionProgressStartedAt: undefined,
				transcriptionError: undefined,
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
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

		await updateTranscriptionProgress(videoId, "EXTRACTING");

		const extracted = await extractAudio(videoId, userId, videoData.bucketId);

		if (!extracted) {
			await clearTranscriptionProgress(videoId);
			await markNoAudio(videoId);
			return {
				success: true,
				message: "Video has no audio track - skipped transcription",
			};
		}

		audioKey = extracted.audioKey;

		await updateTranscriptionProgress(videoId, "TRANSCRIBING");

		const [transcription] = await Promise.all([
			transcribeWithGemini(extracted.audioUrl),
		]);

		await saveTranscription(videoId, userId, videoData.bucketId, transcription);

		if (aiGenerationEnabled) {
			await updateTranscriptionProgress(videoId, "SUMMARIZING");
			await queueAiGeneration(videoId, userId).catch((err) => {
				console.error("[transcribe] AI generation enqueue failed:", err);
			});
		}

		await clearTranscriptionProgress(videoId);

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
		} catch {}
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

### `apps/web/lib/transcribe.ts`

```typescript
import { db } from "@cap/database";
import { organizations, s3Buckets, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
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
		}).catch(async (err) => {
			console.error(`[transcribeVideo] Workflow failed for ${videoId}:`, err);

			const errorMessage =
				err instanceof Error ? err.message : "Transcription failed unexpectedly";

			try {
				const [currentVideo] = await db()
					.select({ metadata: videos.metadata })
					.from(videos)
					.where(eq(videos.id, videoId));

				const currentMetadata =
					(currentVideo?.metadata as VideoMetadata) || {};

				await db()
					.update(videos)
					.set({
						transcriptionStatus: "ERROR",
						metadata: {
							...currentMetadata,
							transcriptionProgress: undefined,
							transcriptionProgressStartedAt: undefined,
							transcriptionError: errorMessage,
						},
					})
					.where(eq(videos.id, videoId));
			} catch (dbErr) {
				console.error(
					`[transcribeVideo] Failed to save error status for ${videoId}:`,
					dbErr,
				);
			}
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

### `apps/web/actions/videos/get-status.ts`

```typescript
"use server";

import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { startAiGeneration } from "@/lib/generate-ai";
import * as EffectRuntime from "@/lib/server";
import { transcribeVideo } from "../../lib/transcribe";
import { isAiGenerationEnabled } from "../../utils/flags";

type TranscriptionStatus =
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED"
	| "NO_AUDIO";

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

type TranscriptionProgress =
	| "EXTRACTING"
	| "TRANSCRIBING"
	| "SUMMARIZING";

export interface VideoStatusResult {
	transcriptionStatus: TranscriptionStatus | null;
	aiGenerationStatus: AiGenerationStatus | null;
	aiTitle: string | null;
	summary: string | null;
	chapters: { title: string; start: number }[] | null;
	error?: string;
	transcriptionProgress?: TranscriptionProgress | null;
	transcriptionError?: string | null;
	transcriptionProgressStartedAt?: string | null;
}

export async function getVideoStatus(
	videoId: Video.VideoId,
): Promise<VideoStatusResult | { success: false }> {
	if (!videoId) throw new Error("Video ID not provided");

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) return { success: false };

	const video = exit.value[0];
	if (!video) throw new Error("Video not found");

	const metadata: VideoMetadata = (video.metadata as VideoMetadata) || {};

	if (!video.transcriptionStatus && serverEnv().GOOGLE_API_KEY) {
		const activeUpload = await db()
			.select({
				videoId: videoUploads.videoId,
				phase: videoUploads.phase,
				updatedAt: videoUploads.updatedAt,
			})
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId))
			.limit(1);

		if (activeUpload.length > 0) {
			const upload = activeUpload[0]!;
			const ageMs = Date.now() - new Date(upload.updatedAt).getTime();
			const isStale = ageMs > 5 * 60 * 1000;

			if (isStale && upload.phase === "uploading") {
				console.log(
					`[Get Status] Cleaning up stale upload record for video ${videoId} (phase: ${upload.phase}, age: ${Math.round(ageMs / 1000)}s)`,
				);
				await db()
					.delete(videoUploads)
					.where(eq(videoUploads.videoId, videoId));
			} else {
				return {
					transcriptionStatus: null,
					aiGenerationStatus:
						(metadata.aiGenerationStatus as AiGenerationStatus) || null,
					aiTitle: metadata.aiTitle || null,
					summary: metadata.summary || null,
					chapters: metadata.chapters || null,
					transcriptionProgress: null,
					transcriptionError: null,
					transcriptionProgressStartedAt: null,
				};
			}
		}

		console.log(
			`[Get Status] Transcription not started for video ${videoId}, triggering transcription`,
		);
		try {
			transcribeVideo(videoId, video.ownerId).catch((error) => {
				console.error(
					`[Get Status] Error starting transcription for video ${videoId}:`,
					error,
				);
			});

			return {
				transcriptionStatus: "PROCESSING",
				aiGenerationStatus:
					(metadata.aiGenerationStatus as AiGenerationStatus) || null,
				aiTitle: metadata.aiTitle || null,
				summary: metadata.summary || null,
				chapters: metadata.chapters || null,
				transcriptionProgress:
					(metadata.transcriptionProgress as TranscriptionProgress) ?? null,
				transcriptionError: metadata.transcriptionError ?? null,
				transcriptionProgressStartedAt:
					metadata.transcriptionProgressStartedAt ?? null,
			};
		} catch (error) {
			console.error(
				`[Get Status] Error triggering transcription for video ${videoId}:`,
				error,
			);
			return {
				transcriptionStatus: "ERROR",
				aiGenerationStatus:
					(metadata.aiGenerationStatus as AiGenerationStatus) || null,
				aiTitle: metadata.aiTitle || null,
				summary: metadata.summary || null,
				chapters: metadata.chapters || null,
				error: "Failed to start transcription",
				transcriptionProgress: null,
				transcriptionError: "Failed to start transcription",
				transcriptionProgressStartedAt: null,
			};
		}
	}

	if (video.transcriptionStatus === "ERROR") {
		return {
			transcriptionStatus: "ERROR",
			aiGenerationStatus:
				(metadata.aiGenerationStatus as AiGenerationStatus) || null,
			aiTitle: metadata.aiTitle || null,
			summary: metadata.summary || null,
			chapters: metadata.chapters || null,
			error: metadata.transcriptionError || "Transcription failed",
			transcriptionProgress: null,
			transcriptionError: metadata.transcriptionError ?? null,
			transcriptionProgressStartedAt: null,
		};
	}

	const shouldTriggerAiGeneration =
		video.transcriptionStatus === "COMPLETE" &&
		!metadata.aiGenerationStatus &&
		!metadata.summary &&
		(serverEnv().GROQ_API_KEY || serverEnv().OPENAI_API_KEY);

	if (shouldTriggerAiGeneration) {
		try {
			const ownerQuery = await db()
				.select({
					email: users.email,
					stripeSubscriptionStatus: users.stripeSubscriptionStatus,
					thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
				})
				.from(users)
				.where(eq(users.id, video.ownerId))
				.limit(1);

			const owner = ownerQuery[0];
			if (owner && (await isAiGenerationEnabled(owner))) {
				console.log(
					`[Get Status] AI generation not started for video ${videoId}, triggering generation`,
				);
				startAiGeneration(videoId, video.ownerId).catch((error) => {
					console.error(
						`[Get Status] Error starting AI generation for video ${videoId}:`,
						error,
					);
				});

				return {
					transcriptionStatus:
						(video.transcriptionStatus as TranscriptionStatus) || null,
					aiGenerationStatus: "QUEUED" as AiGenerationStatus,
					aiTitle: metadata.aiTitle || null,
					summary: metadata.summary || null,
					chapters: metadata.chapters || null,
					transcriptionProgress:
						(metadata.transcriptionProgress as TranscriptionProgress) ?? null,
					transcriptionError: null,
					transcriptionProgressStartedAt:
						metadata.transcriptionProgressStartedAt ?? null,
				};
			}
		} catch (error) {
			console.error(
				`[Get Status] Error checking AI generation eligibility for video ${videoId}:`,
				error,
			);
		}
	}

	return {
		transcriptionStatus:
			(video.transcriptionStatus as TranscriptionStatus) || null,
		aiGenerationStatus:
			(metadata.aiGenerationStatus as AiGenerationStatus) || null,
		aiTitle: metadata.aiTitle || null,
		summary: metadata.summary || null,
		chapters: metadata.chapters || null,
		transcriptionProgress:
			(metadata.transcriptionProgress as TranscriptionProgress) ?? null,
		transcriptionError: metadata.transcriptionError ?? null,
		transcriptionProgressStartedAt:
			metadata.transcriptionProgressStartedAt ?? null,
	};
}
```

### `apps/web/app/s/[videoId]/Share.tsx`

```typescript
"use client";

import type { comments as commentsSchema } from "@cap/database/schema";
import type { ImageUpload, Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import {
	startTransition,
	use,
	useCallback,
	useEffect,
	useMemo,
	useOptimistic,
	useRef,
	useState,
} from "react";
import {
	getVideoStatus,
	type VideoStatusResult,
} from "@/actions/videos/get-status";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";
import { CaptionProvider } from "./_components/CaptionContext";
import { ShareVideo } from "./_components/ShareVideo";
import { Sidebar } from "./_components/Sidebar";
import SummaryChapters from "./_components/SummaryChapters";
import { Toolbar } from "./_components/Toolbar";
import type { VideoData } from "./types";

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
	authorName: string | null;
	authorImage: ImageUpload.ImageUrl | null;
};

export type CommentType = typeof commentsSchema.$inferSelect & {
	authorName?: string | null;
	authorImage?: ImageUpload.ImageUrl | null;
	sending?: boolean;
};

const SESSION_STORAGE_KEY = "cap_tb_session_id";
const SESSION_TTL_MS = 30 * 60 * 1000;

const ensureAnalyticsSessionId = () => {
	if (typeof window === "undefined") return "anonymous";
	try {
		const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
		const now = Date.now();
		if (raw) {
			const parsed = JSON.parse(raw) as { value: string; expiry: number };
			if (parsed?.value && parsed.expiry > now) return parsed.value;
		}
		const newId =
			typeof crypto !== "undefined" && "randomUUID" in crypto
				? crypto.randomUUID()
				: Math.random().toString(36).slice(2);
		window.localStorage.setItem(
			SESSION_STORAGE_KEY,
			JSON.stringify({ value: newId, expiry: now + SESSION_TTL_MS }),
		);
		return newId;
	} catch (error) {
		console.warn("Failed to persist analytics session id", error);
		return "anonymous";
	}
};

const trackVideoView = (payload: {
	videoId: string;
	orgId?: string | null;
	ownerId?: string | null;
}) => {
	if (typeof window === "undefined") return;
	const sessionId = ensureAnalyticsSessionId();
	const screen = window.screen;
	const body = {
		videoId: payload.videoId,
		orgId: payload.orgId,
		ownerId: payload.ownerId,
		sessionId,
		pathname: window.location.pathname,
		href: window.location.href,
		referrer: document.referrer,
		hostname: window.location.hostname,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		language: typeof navigator !== "undefined" ? navigator.language : undefined,
		locale:
			typeof navigator !== "undefined" && navigator.languages?.length
				? navigator.languages[0]
				: undefined,
		screen: screen
			? {
					width: screen.width,
					height: screen.height,
					colorDepth: screen.colorDepth,
				}
			: undefined,
		userAgent:
			typeof navigator !== "undefined" ? navigator.userAgent : undefined,
		occurredAt: new Date().toISOString(),
	};

	const serializedBody = JSON.stringify(body);

	if (
		typeof navigator !== "undefined" &&
		typeof navigator.sendBeacon === "function"
	) {
		try {
			const beaconPayload = new Blob([serializedBody], {
				type: "application/json",
			});
			const queued = navigator.sendBeacon(
				"/api/analytics/track",
				beaconPayload,
			);
			if (queued) {
				return;
			}
		} catch (error) {
			console.warn("Falling back to fetch for analytics tracking", error);
		}
	}

	void fetch("/api/analytics/track", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: serializedBody,
		keepalive: true,
	}).catch((error) => {
		if (error?.name !== "AbortError") {
			console.warn("Failed to track analytics event", error);
		}
	});
};

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

type TranscriptionProgress =
	| "EXTRACTING"
	| "TRANSCRIBING"
	| "SUMMARIZING";

interface ShareProps {
	data: VideoData;
	comments: MaybePromise<CommentWithAuthor[]>;
	views: MaybePromise<number>;
	customDomain: string | null;
	domainVerified: boolean;
	videoSettings?: OrganizationSettings | null;
	userOrganizations?: { id: string; name: string }[];
	viewerId?: string | null;
	initialAiData?: {
		title?: string | null;
		summary?: string | null;
		chapters?: { title: string; start: number }[] | null;
		aiGenerationStatus?: AiGenerationStatus | null;
	} | null;
	aiGenerationEnabled: boolean;
}

const useVideoStatus = (
	videoId: Video.VideoId,
	aiGenerationEnabled: boolean,
	initialData?: {
		transcriptionStatus?: string | null;
		aiData?: {
			title?: string | null;
			summary?: string | null;
			chapters?: { title: string; start: number }[] | null;
			aiGenerationStatus?: AiGenerationStatus | null;
		} | null;
	},
) => {
	return useQuery({
		queryKey: ["videoStatus", videoId],
		queryFn: async (): Promise<VideoStatusResult> => {
			const res = await getVideoStatus(videoId);
			if ("success" in res && res.success === false)
				throw new Error("Failed to fetch video status");
			return res as VideoStatusResult;
		},
		initialData: initialData
			? {
					transcriptionStatus: initialData.transcriptionStatus as
						| "PROCESSING"
						| "COMPLETE"
						| "ERROR"
						| "SKIPPED"
						| "NO_AUDIO"
						| null,
					aiGenerationStatus:
						(initialData.aiData?.aiGenerationStatus as AiGenerationStatus) ||
						null,
					aiTitle: initialData.aiData?.title || null,
					summary: initialData.aiData?.summary || null,
					chapters: initialData.aiData?.chapters || null,
				}
			: undefined,
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) return 2000;

			const shouldContinuePolling = () => {
				if (
					!data.transcriptionStatus ||
					data.transcriptionStatus === "PROCESSING"
				) {
					return true;
				}

				if (
					data.transcriptionStatus === "ERROR" ||
					data.transcriptionStatus === "SKIPPED" ||
					data.transcriptionStatus === "NO_AUDIO"
				) {
					return false;
				}

				if (data.transcriptionStatus === "COMPLETE") {
					if (!aiGenerationEnabled) {
						return false;
					}

					if (
						data.aiGenerationStatus === "SKIPPED" ||
						data.aiGenerationStatus === "ERROR" ||
						data.aiGenerationStatus === "COMPLETE"
					) {
						return false;
					}

					if (
						data.aiGenerationStatus === "QUEUED" ||
						data.aiGenerationStatus === "PROCESSING"
					) {
						return true;
					}

					if (!data.aiGenerationStatus && !data.summary && !data.chapters) {
						return true;
					}

					return false;
				}

				return false;
			};

			return shouldContinuePolling() ? 2000 : false;
		},
		refetchIntervalInBackground: false,
		staleTime: 1000,
	});
};

export const Share = ({
	data,
	comments,
	views,
	initialAiData,
	aiGenerationEnabled,
	videoSettings,
	viewerId,
}: ShareProps) => {
	const effectiveDate: Date = data.metadata?.customCreatedAt
		? new Date(data.metadata.customCreatedAt)
		: data.createdAt;

	const playerRef = useRef<HTMLVideoElement | null>(null);
	const activityRef = useRef<{ scrollToBottom: () => void }>(null);
	const initialComments: CommentType[] =
		comments instanceof Promise ? use(comments) : comments;
	const [commentsData, setCommentsData] =
		useState<CommentType[]>(initialComments);
	const [optimisticComments, setOptimisticComments] = useOptimistic(
		commentsData,
		(state, newComment: CommentType) => {
			return [...state, newComment];
		},
	);

	const { data: videoStatus } = useVideoStatus(data.id, aiGenerationEnabled, {
		transcriptionStatus: data.transcriptionStatus,
		aiData: initialAiData,
	});

	const transcriptionStatus =
		videoStatus?.transcriptionStatus || data.transcriptionStatus;

	const transcriptionProgress: TranscriptionProgress | null =
		videoStatus?.transcriptionProgress ?? (data.metadata as { transcriptionProgress?: TranscriptionProgress } | null)?.transcriptionProgress ?? null;

	const transcriptionError: string | null =
		videoStatus?.transcriptionError ?? (data.metadata as { transcriptionError?: string } | null)?.transcriptionError ?? null;

	const transcriptionProgressStartedAt: string | null =
		videoStatus?.transcriptionProgressStartedAt ?? (data.metadata as { transcriptionProgressStartedAt?: string } | null)?.transcriptionProgressStartedAt ?? null;

	const aiData = useMemo(
		() => ({
			title: videoStatus?.aiTitle || null,
			summary: videoStatus?.summary || null,
			chapters: videoStatus?.chapters || null,
			aiGenerationStatus: videoStatus?.aiGenerationStatus || null,
		}),
		[videoStatus],
	);

	useEffect(() => {
		if (viewerId && viewerId === data.owner.id) {
			return;
		}

		trackVideoView({
			videoId: data.id,
			orgId: data.orgId,
			ownerId: data.owner.id,
		});
	}, [data.id, data.orgId, data.owner.id, viewerId]);

	const shouldShowLoading = () => {
		if (!aiGenerationEnabled) {
			return false;
		}

		if (!transcriptionStatus || transcriptionStatus === "PROCESSING") {
			return true;
		}

		if (
			transcriptionStatus === "ERROR" ||
			transcriptionStatus === "SKIPPED" ||
			transcriptionStatus === "NO_AUDIO"
		) {
			return false;
		}

		if (transcriptionStatus === "COMPLETE") {
			if (
				aiData.aiGenerationStatus === "SKIPPED" ||
				aiData.aiGenerationStatus === "ERROR" ||
				aiData.aiGenerationStatus === "COMPLETE"
			) {
				return false;
			}
			if (
				aiData.aiGenerationStatus === "QUEUED" ||
				aiData.aiGenerationStatus === "PROCESSING"
			) {
				return true;
			}
			if (!aiData.aiGenerationStatus && !aiData.summary && !aiData.chapters) {
				return true;
			}
		}

		return false;
	};

	const aiLoading = shouldShowLoading();

	const searchParams = useSearchParams();
	const initialSeekDone = useRef(false);

	const handleSeek = useCallback((time: number) => {
		const v =
			playerRef.current ??
			(document.querySelector("video") as HTMLVideoElement | null);
		if (!v) {
			console.warn("Video player not ready");
			return;
		}
		const seekOnce = (t: number) => {
			const dur =
				Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
			const clamped = dur ? Math.max(0, Math.min(dur - 0.001, t)) : t;
			try {
				v.currentTime = clamped;
			} catch (e) {
				console.error("Failed to seek video:", e);
			}
		};
		if (v.readyState >= 1) {
			seekOnce(time);
			return;
		}
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const handleReady = () => {
			seekOnce(time);
			v.removeEventListener("canplay", handleReady);
			v.removeEventListener("loadedmetadata", handleReady);
			if (timeoutId) clearTimeout(timeoutId);
		};
		v.addEventListener("canplay", handleReady, { once: true });
		v.addEventListener("loadedmetadata", handleReady, { once: true });
		timeoutId = setTimeout(() => {
			v.removeEventListener("canplay", handleReady);
			v.removeEventListener("loadedmetadata", handleReady);
		}, 3000);
	}, []);

	useEffect(() => {
		if (initialSeekDone.current) return;
		const tParam = searchParams.get("t");
		if (!tParam) return;
		const t = parseInt(tParam, 10);
		if (!Number.isFinite(t) || t < 0) return;

		const v =
			playerRef.current ??
			(document.querySelector("video") as HTMLVideoElement | null);
		if (v) {
			initialSeekDone.current = true;
			handleSeek(t);
			return;
		}

		const interval = setInterval(() => {
			const el =
				playerRef.current ??
				(document.querySelector("video") as HTMLVideoElement | null);
			if (el) {
				clearInterval(interval);
				initialSeekDone.current = true;
				handleSeek(t);
			}
		}, 200);

		const timeout = setTimeout(() => clearInterval(interval), 10000);

		return () => {
			clearInterval(interval);
			clearTimeout(timeout);
		};
	}, [searchParams, handleSeek]);

	const handleOptimisticComment = useCallback(
		(comment: CommentType) => {
			startTransition(() => {
				setOptimisticComments(comment);
			});
			setTimeout(() => {
				activityRef.current?.scrollToBottom();
			}, 100);
		},
		[setOptimisticComments],
	);

	const handleCommentSuccess = useCallback((realComment: CommentType) => {
		startTransition(() => {
			setCommentsData((prev) => [...prev, realComment]);
		});
		setTimeout(() => {
			activityRef.current?.scrollToBottom();
		}, 100);
	}, []);

	const isDisabled = (setting: keyof NonNullable<OrganizationSettings>) =>
		videoSettings?.[setting] ?? data.orgSettings?.[setting] ?? false;

	const areChaptersDisabled = isDisabled("disableChapters");
	const isSummaryDisabled = isDisabled("disableSummary");
	const areCaptionsDisabled = isDisabled("disableCaptions");
	const areCommentStampsDisabled = isDisabled("disableComments");
	const areReactionStampsDisabled = isDisabled("disableReactions");
	const allSettingsDisabled =
		isDisabled("disableComments") &&
		isDisabled("disableSummary") &&
		isDisabled("disableTranscript");

	return (
		<CaptionProvider
			videoId={data.id}
			transcriptionStatus={transcriptionStatus}
		>
			<div className="mt-4">
				<div className="flex flex-col gap-4 lg:flex-row">
					<div className="flex-1">
						<div className="overflow-visible relative bg-white rounded-2xl border aspect-video border-gray-5">
							<div className="absolute inset-3 w-[calc(100%-1.5rem)] h-[calc(100%-1.5rem)] overflow-visible rounded-xl">
								<ShareVideo
									data={{ ...data, transcriptionStatus }}
									comments={comments}
									areChaptersDisabled={areChaptersDisabled}
									areCaptionsDisabled={areCaptionsDisabled}
									areCommentStampsDisabled={areCommentStampsDisabled}
									areReactionStampsDisabled={areReactionStampsDisabled}
									chapters={aiData?.chapters || []}
									aiGenerationStatus={aiData?.aiGenerationStatus}
									canRetryProcessing={viewerId === data.owner.id}
									showPlaybackStatusBadge={viewerId === data.owner.id}
									ref={playerRef}
								/>
							</div>
						</div>
						<div className="mt-4 lg:hidden">
							<Toolbar
								onOptimisticComment={handleOptimisticComment}
								onCommentSuccess={handleCommentSuccess}
								data={data}
							/>
						</div>
					</div>

					{!allSettingsDisabled && (
						<div className="flex flex-col lg:w-80">
							<Sidebar
								data={{
									...data,
									createdAt: effectiveDate,
									transcriptionStatus,
								}}
								videoSettings={videoSettings}
								commentsData={commentsData}
								setCommentsData={setCommentsData}
								optimisticComments={optimisticComments}
								setOptimisticComments={setOptimisticComments}
								handleCommentSuccess={handleCommentSuccess}
								views={views}
								onSeek={handleSeek}
								videoId={data.id}
								aiData={aiData}
								aiGenerationEnabled={aiGenerationEnabled}
								ref={activityRef}
								transcriptionProgress={transcriptionProgress}
								transcriptionError={transcriptionError}
								transcriptionProgressStartedAt={transcriptionProgressStartedAt}
							/>
						</div>
					)}
				</div>

				<div className="hidden mt-4 lg:block">
					<div>
						<Toolbar
							onOptimisticComment={handleOptimisticComment}
							onCommentSuccess={handleCommentSuccess}
							disableReactions={
								videoSettings?.disableReactions ??
								data.orgSettings?.disableReactions
							}
							data={data}
						/>
					</div>
				</div>

				<div className="hidden mt-4 lg:block">
					{aiLoading && (
						<div className="p-4 animate-pulse new-card-style">
							<div className="space-y-6">
								<div>
									<div className="mb-3 w-24 h-6 bg-gray-200 rounded"></div>
									<div className="mb-4 w-32 h-3 bg-gray-100 rounded"></div>
									<div className="space-y-3">
										<div className="w-full h-4 bg-gray-200 rounded"></div>
										<div className="w-5/6 h-4 bg-gray-200 rounded"></div>
										<div className="w-4/5 h-4 bg-gray-200 rounded"></div>
										<div className="w-full h-4 bg-gray-200 rounded"></div>
										<div className="w-3/4 h-4 bg-gray-200 rounded"></div>
									</div>
								</div>

								<div>
									<div className="mb-4 w-24 h-6 bg-gray-200 rounded"></div>
									<div className="space-y-2">
										{[1, 2, 3, 4].map((i) => (
											<div key={i} className="flex items-center p-2">
												<div className="mr-3 w-12 h-4 bg-gray-200 rounded"></div>
												<div className="flex-1 h-4 bg-gray-200 rounded"></div>
											</div>
										))}
									</div>
								</div>
							</div>
						</div>
					)}

					<SummaryChapters
						isSummaryDisabled={isSummaryDisabled}
						areChaptersDisabled={areChaptersDisabled}
						handleSeek={handleSeek}
						aiData={aiData}
						aiLoading={aiLoading}
					/>
				</div>
			</div>
		</CaptionProvider>
	);
};
```

### `apps/web/app/s/[videoId]/_components/Sidebar.tsx`

```typescript
import type { comments as commentsSchema } from "@cap/database/schema";
import { classNames } from "@cap/utils";
import type { ImageUpload, Video } from "@cap/web-domain";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { forwardRef, Suspense, useState } from "react";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { VideoData } from "../types";
import { Activity } from "./tabs/Activity";
import { Settings } from "./tabs/Settings";
import { Summary } from "./tabs/Summary";
import { Transcript } from "./tabs/Transcript";

type TabType = "activity" | "transcript" | "summary" | "settings";

type CommentType = typeof commentsSchema.$inferSelect & {
	authorName?: string | null;
	authorImage?: ImageUpload.ImageUrl | null;
};

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

type TranscriptionProgress =
	| "EXTRACTING"
	| "TRANSCRIBING"
	| "SUMMARIZING";

interface SidebarProps {
	data: VideoData;
	commentsData: CommentType[];
	optimisticComments: CommentType[];
	handleCommentSuccess: (comment: CommentType) => void;
	setOptimisticComments: (newComment: CommentType) => void;
	setCommentsData: React.Dispatch<React.SetStateAction<CommentType[]>>;
	views: MaybePromise<number>;
	onSeek?: (time: number) => void;
	videoSettings?: OrganizationSettings | null;
	videoId: Video.VideoId;
	aiData?: {
		title?: string | null;
		summary?: string | null;
		chapters?: { title: string; start: number }[] | null;
		aiGenerationStatus?: AiGenerationStatus | null;
	} | null;
	aiGenerationEnabled?: boolean;
	transcriptionProgress?: TranscriptionProgress | null;
	transcriptionError?: string | null;
	transcriptionProgressStartedAt?: string | null;
}

const TabContent = motion.div;

const tabVariants = {
	enter: (direction: number) => ({
		x: direction > 0 ? 1000 : -1000,
		opacity: 0,
	}),
	center: {
		zIndex: 1,
		x: 0,
		opacity: 1,
	},
	exit: (direction: number) => ({
		zIndex: 0,
		x: direction < 0 ? 1000 : -1000,
		opacity: 0,
	}),
};

const tabTransition = {
	x: { type: "spring", stiffness: 300, damping: 30 },
	opacity: { duration: 0.2 },
};

export const Sidebar = forwardRef<{ scrollToBottom: () => void }, SidebarProps>(
	(
		{
			data,
			commentsData,
			setCommentsData,
			optimisticComments,
			handleCommentSuccess,
			setOptimisticComments,
			views,
			videoSettings,
			onSeek,
			aiData,
			aiGenerationEnabled = false,
			transcriptionProgress,
			transcriptionError,
			transcriptionProgressStartedAt,
		},
		ref,
	) => {
		const user = useCurrentUser();

		const isOwner = Boolean(user?.id === data.owner.id);
		const isOwnerOrMember = Boolean(
			isOwner || (user && data.organizationMembers?.includes(user.id)),
		);

		const defaultTab = !(
			videoSettings?.disableComments ?? data.orgSettings?.disableComments
		)
			? "activity"
			: !(videoSettings?.disableSummary ?? data.orgSettings?.disableSummary)
				? "summary"
				: !(
							videoSettings?.disableTranscript ??
							data.orgSettings?.disableTranscript
						)
					? "transcript"
					: "activity";

		const [activeTab, setActiveTab] = useState<TabType>(defaultTab);
		const [[page, direction], setPage] = useState([0, 0]);

		const tabs = [
			{
				id: "activity",
				label: "Comments",
				disabled:
					videoSettings?.disableComments ?? data.orgSettings?.disableComments,
			},
			{
				id: "summary",
				label: "Summary",
				disabled:
					videoSettings?.disableSummary ?? data.orgSettings?.disableSummary,
			},
			{
				id: "transcript",
				label: "Transcript",
				disabled:
					videoSettings?.disableTranscript ??
					data.orgSettings?.disableTranscript,
			},
		];

		const paginate = (tabId: TabType) => {
			const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
			const newIndex = tabs.findIndex((tab) => tab.id === tabId);
			const direction = newIndex > currentIndex ? 1 : -1;

			setPage([page + direction, direction]);
			setActiveTab(tabId);
		};

		const renderTabContent = () => {
			switch (activeTab) {
				case "activity":
					return (
						<Suspense
							fallback={<Activity.Skeleton isOwnerOrMember={isOwnerOrMember} />}
						>
							<Activity
								ref={ref}
								views={views}
								comments={commentsData}
								commentsDisabled={
									videoSettings?.disableComments ??
									data.orgSettings?.disableComments ??
									false
								}
								setComments={setCommentsData}
								optimisticComments={optimisticComments}
								setOptimisticComments={setOptimisticComments}
								handleCommentSuccess={handleCommentSuccess}
								isOwnerOrMember={isOwnerOrMember}
								isOwner={isOwner}
								onSeek={onSeek}
								videoId={data.id}
							/>
						</Suspense>
					);
				case "summary":
					return (
						<Summary
							videoId={data.id}
							ownerIsPro={data.owner.isPro}
							onSeek={onSeek}
							isSummaryDisabled={videoSettings?.disableSummary}
							initialAiData={aiData || undefined}
							aiGenerationEnabled={aiGenerationEnabled}
						/>
					);
				case "transcript":
					return (
						<Transcript
							data={data}
							onSeek={onSeek}
							transcriptionProgress={transcriptionProgress}
							transcriptionError={transcriptionError}
							transcriptionProgressStartedAt={transcriptionProgressStartedAt}
						/>
					);
				case "settings":
					return <Settings />;
				default:
					return null;
			}
		};

		const allTabsDisabled = tabs.every((tab) => tab.disabled);

		return (
			<div className="bg-white rounded-2xl border border-gray-5 overflow-hidden h-[calc(100vh-16rem)] lg:h-full flex flex-col lg:aspect-video">
				<div className="flex-none">
					<div
						className={clsx(
							"flex border-b border-gray-5",
							allTabsDisabled && "hidden",
						)}
					>
						{tabs
							.filter((tab) => !tab.disabled)
							.map((tab) => (
								<button
									type="button"
									key={tab.id}
									onClick={() => paginate(tab.id as TabType)}
									className={classNames(
										"flex-1 px-5 py-3 text-sm font-medium relative transition-colors duration-200",
										"hover:bg-gray-1",
										activeTab === tab.id ? "bg-gray-3" : "",
									)}
								>
									<span
										className={classNames(
											"relative z-10 text-sm",
											activeTab === tab.id ? "text-gray-12" : "text-gray-9",
										)}
									>
										{tab.label}
									</span>
									{activeTab === tab.id && (
										<motion.div
											layoutId="activeTab"
											className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500"
											initial={false}
											transition={{
												type: "spring",
												stiffness: 500,
												damping: 30,
											}}
										/>
									)}
								</button>
							))}
					</div>
				</div>
				<div className="flex-1 min-h-0">
					<div className="overflow-hidden relative h-full">
						<AnimatePresence initial={false} custom={direction}>
							<TabContent
								key={activeTab}
								custom={direction}
								variants={tabVariants}
								initial="enter"
								animate="center"
								exit="exit"
								transition={tabTransition}
								className="overflow-auto absolute inset-0"
							>
								<div className="h-full">{renderTabContent()}</div>
							</TabContent>
						</AnimatePresence>
					</div>
				</div>
			</div>
		);
	},
);
```

### `apps/web/app/s/[videoId]/_components/tabs/Transcript.tsx`

```typescript
"use client";

import { Button } from "@cap/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useInvalidateTranscript, useTranscript } from "hooks/use-transcript";
import {
	Check,
	ChevronDown,
	Copy,
	Download,
	Edit3,
	Globe,
	MessageSquare,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { editTranscriptEntry } from "@/actions/videos/edit-transcript";
import {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
} from "@/actions/videos/translation-languages";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { VideoData } from "../../types";
import { type CaptionLanguage, useCaptionContext } from "../CaptionContext";

type TranscriptionProgress =
	| "EXTRACTING"
	| "TRANSCRIBING"
	| "SUMMARIZING";

interface TranscriptProps {
	data: VideoData;
	onSeek?: (time: number) => void;
	user?: { id: string } | null;
	transcriptionProgress?: TranscriptionProgress | null;
	transcriptionError?: string | null;
	transcriptionProgressStartedAt?: string | null;
}

interface TranscriptEntry {
	id: number;
	timestamp: string;
	text: string;
	startTime: number;
}

const parseVTT = (vttContent: string): TranscriptEntry[] => {
	const lines = vttContent.split("\n");
	const entries: TranscriptEntry[] = [];
	let currentEntry: Partial<TranscriptEntry & { startTime: number }> = {};
	let nextId = 0;
	let currentId: number | null = null;

	const timeToSeconds = (timeStr: string): number | null => {
		const parts = timeStr.split(":");
		if (parts.length !== 3) return null;

		const [hoursStr, minutesStr, secondsStr] = parts;
		if (!hoursStr || !minutesStr || !secondsStr) return null;

		const hours = parseInt(hoursStr, 10);
		const minutes = parseInt(minutesStr, 10);
		const seconds = parseInt(secondsStr, 10);

		if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds))
			return null;

		return hours * 3600 + minutes * 60 + seconds;
	};

	const parseTimestamp = (
		timestamp: string,
	): { displayTime: string; totalSeconds: number } | null => {
		const parts = timestamp.split(":");
		if (parts.length !== 3) return null;

		const [hoursStr, minutesStr, secondsWithMs] = parts;
		if (!hoursStr || !minutesStr || !secondsWithMs) return null;

		const secondsPart = secondsWithMs.split(".")[0];
		if (!secondsPart) return null;

		const totalSeconds = timeToSeconds(
			`${hoursStr}:${minutesStr}:${secondsPart}`,
		);
		if (totalSeconds === null) return null;

		const totalMinutes = Math.floor(totalSeconds / 60);
		const displaySeconds = totalSeconds % 60;

		return {
			displayTime: `${totalMinutes}:${displaySeconds.toString().padStart(2, "0")}`,
			totalSeconds,
		};
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line?.trim()) continue;

		const trimmedLine = line.trim();

		if (trimmedLine === "WEBVTT") continue;

		if (/^\d+$/.test(trimmedLine)) {
			currentId = parseInt(trimmedLine, 10);
			continue;
		}

		if (trimmedLine.includes("-->")) {
			const [startTimeStr, endTimeStr] = trimmedLine.split(" --> ");
			if (!startTimeStr || !endTimeStr) continue;

			const startTimestamp = parseTimestamp(startTimeStr);
			if (startTimestamp) {
				const resolvedId = currentId ?? ++nextId;
				currentEntry = {
					id: resolvedId,
					timestamp: startTimestamp.displayTime,
					startTime: startTimestamp.totalSeconds,
				};
				currentId = null;
			}
			continue;
		}

		if (currentEntry.timestamp && !currentEntry.text) {
			const textContent =
				trimmedLine.startsWith('"') && trimmedLine.endsWith('"')
					? trimmedLine.slice(1, -1)
					: trimmedLine;

			currentEntry.text = textContent;
			if (
				currentEntry.id !== undefined &&
				currentEntry.timestamp &&
				currentEntry.text &&
				currentEntry.startTime !== undefined
			) {
				entries.push(currentEntry as TranscriptEntry);
			}
			currentEntry = {};
		}
	}

	const sortedEntries = entries.sort((a, b) => a.startTime - b.startTime);
	return sortedEntries;
};

const PROGRESS_LABELS: Record<TranscriptionProgress, string> = {
	EXTRACTING: "Extracting audio...",
	TRANSCRIBING: "Transcribing...",
	SUMMARIZING: "Generating summary...",
};

const ElapsedTimer = ({ startedAt }: { startedAt: string }) => {
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		const startTime = new Date(startedAt).getTime();
		if (Number.isNaN(startTime)) {
			return;
		}
		const update = () => {
			const now = Date.now();
			const delta = Math.max(0, now - startTime);
			setElapsed(Math.floor(delta / 1000));
		};
		update();
		const interval = setInterval(update, 1000);
		return () => clearInterval(interval);
	}, [startedAt]);

	const minutes = Math.floor(elapsed / 60);
	const seconds = elapsed % 60;

	if (minutes > 0) {
		return (
			<span className="text-xs text-gray-8">
				{minutes}m {seconds.toString().padStart(2, "0")}s
			</span>
		);
	}

	return (
		<span className="text-xs text-gray-8">
			{seconds}s
		</span>
	);
};

export const Transcript: React.FC<TranscriptProps> = ({
	data,
	onSeek,
	transcriptionProgress,
	transcriptionError,
	transcriptionProgressStartedAt,
}) => {
	const user = useCurrentUser();
	const queryClient = useQueryClient();
	const captionContext = useCaptionContext();
	const [transcriptData, setTranscriptData] = useState<TranscriptEntry[]>([]);
	const [selectedEntry, setSelectedEntry] = useState<number | null>(null);
	const [retryTriggered, setRetryTriggered] = useState(false);
	const [editingEntry, setEditingEntry] = useState<number | null>(null);
	const [editText, setEditText] = useState<string>("");
	const [isSaving, setIsSaving] = useState(false);
	const [isCopying, setIsCopying] = useState(false);
	const [copyPressed, setCopyPressed] = useState(false);
	const [downloadPressed, setDownloadPressed] = useState(false);
	const [showLanguageMenu, setShowLanguageMenu] = useState(false);
	const languageMenuRef = useRef<HTMLDivElement>(null);

	const selectedLanguage =
		captionContext.selectedLanguage === "off"
			? "original"
			: captionContext.selectedLanguage;
	const isTranslating = captionContext.isTranslating;
	const _translatedContent = captionContext.translatedVttContent;

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (
				languageMenuRef.current &&
				!languageMenuRef.current.contains(event.target as Node)
			) {
				setShowLanguageMenu(false);
			}
		};

		if (showLanguageMenu) {
			document.addEventListener("mousedown", handleClickOutside);
		}

		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [showLanguageMenu]);

	const {
		data: transcriptContent,
		isLoading: isTranscriptLoading,
		error: transcriptError,
	} = useTranscript(data.id, data.transcriptionStatus);

	const invalidateTranscript = useInvalidateTranscript();

	const retryTranscriptionMutation = useMutation({
		mutationFn: async () => {
			const response = await fetch(
				`/api/videos/${data.id}/retry-transcription`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to retry transcription: ${errorText}`);
			}

			return response.json();
		},
		onSuccess: () => {
			setRetryTriggered(true);
			invalidateTranscript(data.id);
			queryClient.invalidateQueries({
				queryKey: ["videoStatus", data.id],
			});
		},
	});

	useEffect(() => {
		const vttContent = captionContext.currentVttContent;
		if (vttContent) {
			const parsed = parseVTT(vttContent);
			setTranscriptData(parsed);
		} else if (transcriptContent && selectedLanguage === "original") {
			const parsed = parseVTT(transcriptContent);
			setTranscriptData(parsed);
		}
	}, [captionContext.currentVttContent, transcriptContent, selectedLanguage]);

	const handleLanguageChange = async (language: CaptionLanguage) => {
		setShowLanguageMenu(false);
		captionContext.setSelectedLanguage(language);
	};

	const isTranscriptionProcessing = useMemo(() => {
		if (
			data.transcriptionStatus === "SKIPPED" ||
			data.transcriptionStatus === "NO_AUDIO"
		) {
			return false;
		}
		if (retryTriggered && data.transcriptionStatus !== "COMPLETE") {
			return true;
		}
		return (
			data.transcriptionStatus === "PROCESSING" || !data.transcriptionStatus
		);
	}, [data.transcriptionStatus, retryTriggered]);

	const isQueryLoading =
		isTranscriptLoading && data.transcriptionStatus === "COMPLETE";

	const hasTimedOut = useMemo(() => {
		const videoCreationTime = new Date(data.createdAt).getTime();
		const fiveMinutesInMs = 5 * 60 * 1000;
		const isVideoOlderThanFiveMinutes =
			Date.now() - videoCreationTime > fiveMinutesInMs;
		return (
			isVideoOlderThanFiveMinutes &&
			!data.transcriptionStatus &&
			!retryTriggered
		);
	}, [data.createdAt, data.transcriptionStatus, retryTriggered]);

	const handleTranscriptClick = (entry: TranscriptEntry) => {
		if (editingEntry === entry.id) {
			return;
		}

		setSelectedEntry(entry.id);

		onSeek?.(entry.startTime);
	};

	const startEditing = (entry: TranscriptEntry) => {
		setEditingEntry(entry.id);
		setEditText(entry.text);
	};

	const cancelEditing = () => {
		setEditingEntry(null);
		setEditText("");
	};

	const saveEdit = async () => {
		if (!editingEntry || !editText.trim()) {
			return;
		}

		const _originalEntry = transcriptData.find(
			(entry) => entry.id === editingEntry,
		);

		setIsSaving(true);
		try {
			const result = await editTranscriptEntry(data.id, editingEntry, editText);

			if (result.success) {
				setTranscriptData((prev) =>
					prev.map((entry) =>
						entry.id === editingEntry
							? { ...entry, text: editText.trim() }
							: entry,
					),
				);
				setEditingEntry(null);
				setEditText("");
				invalidateTranscript(data.id);
			} else {
				console.error("[Transcript] Failed to save transcript edit:", {
					entryId: editingEntry,
					videoId: data.id,
					errorMessage: result.message,
					result,
				});
			}
		} catch (error) {
			console.error("[Transcript] Error saving transcript edit:", {
				entryId: editingEntry,
				videoId: data.id,
				error: error instanceof Error ? error.message : error,
				stack: error instanceof Error ? error.stack : undefined,
			});
		} finally {
			setIsSaving(false);
		}
	};

	const formatTranscriptForClipboard = (entries: TranscriptEntry[]): string => {
		return entries
			.map((entry) => `[${entry.timestamp}] ${entry.text}`)
			.join("\n\n");
	};

	const formatTranscriptAsVTT = (entries: TranscriptEntry[]): string => {
		const vttHeader = "WEBVTT\n\n";

		const vttEntries = entries.map((entry, index) => {
			const startSeconds = entry.startTime;
			const nextEntry = entries[index + 1];
			const endSeconds = nextEntry ? nextEntry.startTime : startSeconds + 3;

			const formatTime = (seconds: number): string => {
				const hours = Math.floor(seconds / 3600);
				const minutes = Math.floor((seconds % 3600) / 60);
				const secs = Math.floor(seconds % 60);
				const milliseconds = Math.floor((seconds % 1) * 1000);

				return `${hours.toString().padStart(2, "0")}:${minutes
					.toString()
					.padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${milliseconds
					.toString()
					.padStart(3, "0")}`;
			};

			return `${entry.id}\n${formatTime(startSeconds)} --> ${formatTime(
				endSeconds,
			)}\n${entry.text}\n`;
		});

		return vttHeader + vttEntries.join("\n");
	};

	const copyTranscriptToClipboard = async () => {
		if (transcriptData.length === 0) return;

		setIsCopying(true);
		try {
			const formattedTranscript = formatTranscriptForClipboard(transcriptData);
			await navigator.clipboard.writeText(formattedTranscript);
			setCopyPressed(true);
			setTimeout(() => {
				setCopyPressed(false);
			}, 2000);
		} catch (error) {
			console.error("Failed to copy transcript:", error);
		} finally {
			setIsCopying(false);
		}
	};

	const downloadTranscriptFile = () => {
		if (transcriptData.length === 0) return;

		const vttContent = formatTranscriptAsVTT(transcriptData);
		const blob = new Blob([vttContent], { type: "text/vtt" });
		const url = URL.createObjectURL(blob);

		const langSuffix =
			selectedLanguage === "original" ? "" : `.${selectedLanguage}`;
		const link = document.createElement("a");
		link.href = url;
		link.download = `transcript-${data.id}${langSuffix}.vtt`;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);

		URL.revokeObjectURL(url);

		setDownloadPressed(true);
		setTimeout(() => {
			setDownloadPressed(false);
		}, 2000);
	};

	const canEdit = user?.id === data.owner.id && selectedLanguage === "original";

	if (isTranscriptionProcessing && !hasTimedOut) {
		const progressLabel = transcriptionProgress
			? PROGRESS_LABELS[transcriptionProgress]
			: "Transcription in progress...";

		const showElapsed =
			transcriptionProgress === "TRANSCRIBING" &&
			transcriptionProgressStartedAt;

		return (
			<div className="flex justify-center items-center h-full text-gray-1">
				<div className="text-center">
					<div className="mb-3">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							className="mx-auto w-8 h-8"
							viewBox="0 0 24 24"
						>
							<style>
								{"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
							</style>
							<path
								fill="#9CA3AF"
								d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
								opacity={0.25}
							/>
							<path
								fill="#9CA3AF"
								d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
								style={{
									transformOrigin: "center",
									animation: "spinner_AtaB .75s infinite linear",
								}}
							/>
						</svg>
					</div>
					<p className="text-sm font-medium text-gray-12">{progressLabel}</p>
					{showElapsed && (
						<div className="mt-1">
							<ElapsedTimer startedAt={transcriptionProgressStartedAt} />
						</div>
					)}
				</div>
			</div>
		);
	}

	if (isQueryLoading) {
		return (
			<div className="flex justify-center items-center h-full">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					className="w-8 h-8"
					viewBox="0 0 24 24"
				>
					<style>
						{"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
					</style>
					<path
						fill="#4B5563"
						d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
						opacity={0.25}
					/>
					<path
						fill="#4B5563"
						d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
						style={{
							transformOrigin: "center",
							animation: "spinner_AtaB .75s infinite linear",
						}}
					/>
				</svg>
			</div>
		);
	}

	if (data.transcriptionStatus === "NO_AUDIO") {
		return (
			<div className="flex justify-center items-center h-full text-gray-1">
				<div className="text-center">
					<MessageSquare className="mx-auto mb-2 w-8 h-8 text-gray-300" />
					<p className="text-sm font-medium text-gray-12">
						No audio track detected
					</p>
					<p className="mt-1 text-xs text-gray-9">
						This video doesn't contain audio for transcription
					</p>
					{canEdit && (
						<>
							<Button
								type="button"
								onClick={() => {
									retryTranscriptionMutation.mutate();
								}}
								disabled={retryTranscriptionMutation.isPending}
								variant="primary"
								size="sm"
								spinner={retryTranscriptionMutation.isPending}
								className="mt-4"
							>
								{retryTranscriptionMutation.isPending
									? "Retrying..."
									: "Retry transcription"}
							</Button>
							{retryTranscriptionMutation.isError && (
								<p className="mt-2 text-xs text-red-500">
									Failed to retry. Please try again.
								</p>
							)}
						</>
					)}
				</div>
			</div>
		);
	}

	if (data.transcriptionStatus === "SKIPPED") {
		return (
			<div className="flex justify-center items-center h-full text-gray-1">
				<div className="text-center">
					<MessageSquare className="mx-auto mb-2 w-8 h-8 text-gray-300" />
					<p className="text-sm font-medium text-gray-12">
						Transcription disabled
					</p>
					<p className="mt-1 text-xs text-gray-9">
						Transcription has been disabled for this video
					</p>
				</div>
			</div>
		);
	}

	const showRetryButton =
		data.transcriptionStatus === "ERROR" ||
		hasTimedOut ||
		(data.transcriptionStatus === "COMPLETE" &&
			!transcriptData.length &&
			!isQueryLoading &&
			transcriptError);

	if (showRetryButton) {
		const errorDetail =
			data.transcriptionStatus === "ERROR" && transcriptionError
				? transcriptionError
				: data.transcriptionStatus === "ERROR"
					? "Transcription failed"
					: "No transcript available";

		return (
			<div className="flex justify-center items-center h-full text-gray-1">
				<div className="text-center px-4">
					<MessageSquare className="mx-auto mb-2 w-8 h-8 text-gray-300" />
					<p className="mb-2 text-sm font-medium text-gray-12">
						{data.transcriptionStatus === "ERROR"
							? "Transcription failed"
							: "No transcript available"}
					</p>
					{data.transcriptionStatus === "ERROR" && transcriptionError && (
						<p className="mb-4 text-xs text-gray-9 max-w-[240px] mx-auto break-words">
							{transcriptionError}
						</p>
					)}
					{canEdit && (
						<>
							<Button
								onClick={() => {
									retryTranscriptionMutation.mutate();
								}}
								disabled={retryTranscriptionMutation.isPending}
								variant="primary"
								size="sm"
								spinner={retryTranscriptionMutation.isPending}
							>
								{retryTranscriptionMutation.isPending
									? "Retrying..."
									: "Retry Transcription"}
							</Button>
							{retryTranscriptionMutation.isError && (
								<p className="mt-2 text-xs text-red-500">
									Failed to retry. Please try again.
								</p>
							)}
						</>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<div className="p-4 border-b border-gray-3">
				<div className="flex flex-col gap-3">
					<div className="flex gap-2 justify-end">
						<Button
							onClick={copyTranscriptToClipboard}
							disabled={isCopying || transcriptData.length === 0}
							variant="white"
							size="xs"
							spinner={isCopying}
						>
							{!copyPressed ? (
								<Copy className="mr-1 w-3 h-3" />
							) : (
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="mr-1 w-3 h-3 svgpathanimation"
								>
									<path d="M20 6 9 17l-5-5" />
								</svg>
							)}
							{copyPressed ? "Copied" : "Copy Transcript"}
						</Button>
						<Button
							onClick={downloadTranscriptFile}
							disabled={transcriptData.length === 0}
							variant="white"
							size="xs"
						>
							{!downloadPressed ? (
								<Download className="mr-1 w-3 h-3" />
							) : (
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="mr-1 w-3 h-3 svgpathanimation"
								>
									<path d="M20 6 9 17l-5-5" />
								</svg>
							)}
							{downloadPressed ? "Downloaded" : "Download"}
						</Button>
					</div>
					<div className="relative" ref={languageMenuRef}>
						<button
							onClick={() => setShowLanguageMenu(!showLanguageMenu)}
							disabled={isTranslating || transcriptData.length === 0}
							className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-3 bg-gray-1 hover:bg-gray-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
							type="button"
						>
							<Globe className="w-3 h-3 text-gray-9" />
							<span className="text-gray-12">
								{isTranslating
									? "Translating..."
									: selectedLanguage === "original"
										? "Original"
										: SUPPORTED_LANGUAGES[selectedLanguage]}
							</span>
							<ChevronDown className="w-3 h-3 text-gray-9" />
						</button>
						{showLanguageMenu && (
							<div className="absolute left-0 top-full mt-1 z-50 w-48 py-1 bg-gray-1 border border-gray-3 rounded-lg shadow-lg max-h-64 overflow-y-auto">
								<button
									onClick={() => handleLanguageChange("original")}
									className={`w-full px-3 py-1.5 text-left text-xs hover:bg-gray-2 transition-colors ${
										selectedLanguage === "original"
											? "text-blue-500 font-medium"
											: "text-gray-12"
									}`}
									type="button"
								>
									Original
								</button>
								<div className="my-1 border-t border-gray-3" />
								{(
									Object.entries(SUPPORTED_LANGUAGES) as [
										LanguageCode,
										string,
									][]
								).map(([code, name]) => (
									<button
										key={code}
										onClick={() => handleLanguageChange(code)}
										className={`w-full px-3 py-1.5 text-left text-xs hover:bg-gray-2 transition-colors ${
											selectedLanguage === code
												? "text-blue-500 font-medium"
												: "text-gray-12"
										}`}
										type="button"
									>
										{name}
										{captionContext.translatedVttContent.has(code) && (
											<span className="ml-1.5 text-gray-9">(cached)</span>
										)}
									</button>
								))}
							</div>
						)}
					</div>
				</div>
			</div>

			<div className="overflow-y-auto flex-1 relative">
				{isTranslating && (
					<div className="absolute inset-0 bg-gray-1/80 flex items-center justify-center z-10">
						<div className="text-center">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								className="mx-auto w-8 h-8"
								viewBox="0 0 24 24"
							>
								<style>
									{"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
								</style>
								<path
									fill="#9CA3AF"
									d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
									opacity={0.25}
								/>
								<path
									fill="#9CA3AF"
									d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
									style={{
										transformOrigin: "center",
										animation: "spinner_AtaB .75s infinite linear",
									}}
								/>
							</svg>
							<p className="mt-2 text-sm text-gray-11">
								Translating transcript...
							</p>
						</div>
					</div>
				)}
				<div className="p-4 space-y-3">
					{transcriptData.map((entry) => (
						<div
							key={entry.id}
							className={`group rounded-lg transition-colors ${
								editingEntry === entry.id
									? "bg-gray-1 border border-gray-4 p-3"
									: selectedEntry === entry.id
										? "bg-gray-2 p-3"
										: "hover:bg-gray-2 p-3"
							} ${editingEntry === entry.id ? "" : "cursor-pointer"}`}
							onClick={() => handleTranscriptClick(entry)}
						>
							<div className="flex justify-between items-start mb-2">
								<div className="text-xs font-medium text-gray-8">
									{entry.timestamp}
								</div>
								{canEdit && editingEntry !== entry.id && (
									<button
										onClick={(e) => {
											e.stopPropagation();
											startEditing(entry);
										}}
										type="button"
										className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-gray-3 rounded-md transition-all duration-200"
										title="Edit transcript"
									>
										<Edit3 className="w-3.5 h-3.5 text-gray-9" />
									</button>
								)}
							</div>

							{editingEntry === entry.id ? (
								<div className="space-y-3">
									<div className="p-3 rounded-lg border bg-gray-1 border-gray-4">
										<textarea
											value={editText}
											onChange={(e) => setEditText(e.target.value)}
											className="w-full text-sm leading-relaxed bg-transparent resize-none text-gray-12 placeholder:text-gray-8 focus:outline-none"
											rows={Math.max(2, Math.ceil(editText.length / 60))}
											onClick={(e) => e.stopPropagation()}
											placeholder="Edit transcript text..."
										/>
									</div>
									<div className="flex gap-2 justify-end">
										<Button
											onClick={(e) => {
												e.stopPropagation();
												cancelEditing();
											}}
											disabled={isSaving}
											variant="white"
											size="xs"
											className="min-w-[70px]"
										>
											<X className="mr-1 w-3 h-3" />
											Cancel
										</Button>
										<Button
											onClick={(e) => {
												e.stopPropagation();
												saveEdit();
											}}
											disabled={isSaving || !editText.trim()}
											variant="primary"
											size="xs"
											className="min-w-[70px]"
											spinner={isSaving}
										>
											<Check className="mr-1 w-3 h-3" />
											Save
										</Button>
									</div>
								</div>
							) : (
								<div className="text-sm leading-relaxed text-gray-12">
									{entry.text}
								</div>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
};
```

## Open Questions

- The `retry-transcription` route resets `transcriptionStatus` to `null` but does not clear `metadata.transcriptionError`. This means a stale error message could persist after a successful retry. However, the workflow's `updateTranscriptionProgress` function clears `transcriptionError` when setting a new progress state, so the stale error will be cleared as soon as the new workflow starts writing progress. This is acceptable behavior: the error message shows briefly during the transition, then disappears.

## Key Files

- `packages/database/types/metadata.ts` - adds `transcriptionProgress`, `transcriptionError`, and `transcriptionProgressStartedAt` fields to `VideoMetadata` (preserves existing `transcriptionStartedAt`)
- `apps/web/workflows/transcribe.ts` - writes granular progress at each workflow stage, wraps queueAiGeneration in .catch() (TPUX-5)
- `apps/web/lib/transcribe.ts` - catches workflow errors and saves error details to metadata
- `apps/web/actions/videos/get-status.ts` - exposes progress and error fields in `VideoStatusResult`
- `apps/web/app/s/[videoId]/Share.tsx` - extracts progress data from video status with metadata fallback (TPUX-4)
- `apps/web/app/s/[videoId]/_components/Sidebar.tsx` - passes progress props through to Transcript tab
- `apps/web/app/s/[videoId]/_components/tabs/Transcript.tsx` - renders granular progress states with elapsed timer and error messages, fixes VTT parser IDs (TPUX-1), timestamp display (TPUX-2), and elapsed timer guards (TPUX-3)
