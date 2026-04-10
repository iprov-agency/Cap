---
created: 2026-04-09
system: cap
status: approved
target_agent: worktree
acceptance_criteria:
  - "Does get-status.ts call generateAiWorkflow directly instead of startAiGeneration after claiming the work?"
  - "Does the .catch handler in generate-ai.ts update aiGenerationStatus to ERROR in the database?"
  - "Does generateAiWorkflow wrap its body in a top-level try/catch that sets ERROR status on unhandled failure?"
  - "Do the existing callers of startAiGeneration (retry-ai route, video/ai route, transcribe workflow) still work unchanged?"
depends_on:
supersedes:
repos:
  - Cap
---

# Fix AI Summary Deadlock

## Problem

The AI summary auto-trigger in `get-status.ts` creates a deadlock. It atomically sets `aiGenerationStatus` to `PROCESSING` via SQL (lines 238-258), then calls `startAiGeneration()` fire-and-forget (line 274). But `startAiGeneration()` reads the video from the database, sees the status is already `PROCESSING` (set moments ago), and returns immediately with `{success: true, message: "AI generation already in progress"}` without ever running the workflow. The workflow never executes, and the status stays stuck at PROCESSING permanently.

Additionally, two error recovery gaps exist: (1) the `.catch()` handler in `generate-ai.ts` (line 85-87) only logs errors but never updates the status to ERROR, so if the workflow throws, the status stays stuck; (2) `generateAiWorkflow` in `workflows/generate-ai.ts` has no top-level error handler, so unhandled exceptions leave status as PROCESSING forever.

## Design

Three targeted changes to fix the deadlock and add error recovery:

1. **get-status.ts: bypass startAiGeneration, call generateAiWorkflow directly.** Since `triggerAiGenerationIfEligible` already atomically claimed the work (set PROCESSING via SQL), it should call `generateAiWorkflow` directly. This bypasses `startAiGeneration`'s status guard that causes the deadlock. The `.catch()` handler uses a guarded read-then-update pattern: it skips the ERROR update for control-flow FatalErrors, reads fresh metadata before writing, and skips the write if the status is already COMPLETE or if summary and chapters already exist.

2. **generate-ai.ts: update status to ERROR in .catch handler.** When `generateAiWorkflow` fires from `startAiGeneration` and fails, the `.catch()` must update the database status to ERROR so the user can retry. This applies to the API route callers (retry-ai, video/ai) that still go through `startAiGeneration`. The handler guards against overwriting a COMPLETE status (in case a concurrent workflow succeeded) and clears `aiGenerationClaimedAt` to release stale claims.

3. **workflows/generate-ai.ts: add top-level try/catch.** Wrap the workflow body in a try/catch that sets `aiGenerationStatus` to ERROR on any unhandled failure. Control-flow FatalErrors ("AI metadata already generated", "Transcription not complete") are excluded from the ERROR status update since they represent expected conditions, not failures. Export `FatalError` and `CONTROL_FLOW_FATAL_MESSAGES` so callers can apply the same guards. This ensures no code path can leave the status stuck at PROCESSING.

### Why not change startAiGeneration itself?

The `startAiGeneration` status guard ("already PROCESSING" check) is correct behavior for its other callers (retry-ai API, video/ai API, transcribe workflow). Those callers have NOT pre-claimed the work. If we removed the guard, two concurrent API calls could both start the workflow. The guard is only wrong for the get-status.ts path, which pre-claims.

## Acceptance Criteria

- [ ] Does get-status.ts call generateAiWorkflow directly instead of startAiGeneration after claiming the work?
- [ ] Does the .catch handler in generate-ai.ts update aiGenerationStatus to ERROR in the database?
- [ ] Does generateAiWorkflow wrap its body in a top-level try/catch that sets ERROR status on unhandled failure?
- [ ] Do the existing callers of startAiGeneration (retry-ai route, video/ai route, transcribe workflow) still work unchanged?

## Implementation

### `apps/web/actions/videos/get-status.ts`

```typescript
"use server";

import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Effect, Exit } from "effect";
import {
	CONTROL_FLOW_FATAL_MESSAGES,
	FatalError,
	generateAiWorkflow,
} from "@/workflows/generate-ai";
import * as EffectRuntime from "@/lib/server";
import { transcribeVideo } from "../../lib/transcribe";
import { isAiGenerationEnabled } from "../../utils/flags";

const VALID_TRANSCRIPTION_STATUSES = [
	"PROCESSING",
	"COMPLETE",
	"ERROR",
	"SKIPPED",
	"NO_AUDIO",
] as const;

type TranscriptionStatus = (typeof VALID_TRANSCRIPTION_STATUSES)[number];

function isValidTranscriptionStatus(
	value: unknown,
): value is TranscriptionStatus {
	return (
		typeof value === "string" &&
		(VALID_TRANSCRIPTION_STATUSES as readonly string[]).includes(value)
	);
}

const VALID_AI_GENERATION_STATUSES = [
	"PROCESSING",
	"QUEUED",
	"COMPLETE",
	"ERROR",
	"SKIPPED",
] as const;

type AiGenerationStatus = (typeof VALID_AI_GENERATION_STATUSES)[number];

function isValidAiGenerationStatus(
	value: unknown,
): value is AiGenerationStatus {
	return (
		typeof value === "string" &&
		(VALID_AI_GENERATION_STATUSES as readonly string[]).includes(value)
	);
}

type TranscriptionProgress = "EXTRACTING" | "TRANSCRIBING" | "SUMMARIZING";

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

const ACTIVE_UPLOAD_PHASES = [
	"uploading",
	"processing",
	"generating_thumbnail",
] as const;

const PHASE_STALE_TIMEOUTS: Record<string, number> = {
	uploading: 5 * 60 * 1000,
	processing: 15 * 60 * 1000,
	generating_thumbnail: 10 * 60 * 1000,
};

const DEFAULT_STALE_TIMEOUT_MS = 5 * 60 * 1000;

const AI_GENERATION_CLAIM_TTL_MS = 10 * 60 * 1000;

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

function buildStatusResponse(
	transcriptionStatus: TranscriptionStatus | null,
	aiGenerationStatus: AiGenerationStatus | null,
	metadata: VideoMetadata,
	overrides?: Partial<VideoStatusResult>,
): VideoStatusResult {
	return {
		transcriptionStatus,
		aiGenerationStatus,
		aiTitle: metadata.aiTitle || null,
		summary: metadata.summary || null,
		chapters: metadata.chapters || null,
		transcriptionProgress:
			(metadata.transcriptionProgress as TranscriptionProgress) ?? null,
		transcriptionError: metadata.transcriptionError ?? null,
		transcriptionProgressStartedAt:
			metadata.transcriptionProgressStartedAt ?? null,
		...overrides,
	};
}

async function checkActiveUploads(
	videoId: Video.VideoId,
): Promise<"active" | "stale_cleaned" | "none"> {
	try {
		const activeUpload = await db()
			.select({
				videoId: videoUploads.videoId,
				phase: videoUploads.phase,
				updatedAt: videoUploads.updatedAt,
			})
			.from(videoUploads)
			.where(
				and(
					eq(videoUploads.videoId, videoId),
					inArray(videoUploads.phase, [...ACTIVE_UPLOAD_PHASES]),
				),
			)
			.orderBy(desc(videoUploads.updatedAt))
			.limit(1);

		if (activeUpload.length === 0) {
			return "none";
		}

		const upload = activeUpload[0];
		const ageMs = Date.now() - new Date(upload.updatedAt).getTime();
		const phaseTimeout =
			PHASE_STALE_TIMEOUTS[upload.phase] ?? DEFAULT_STALE_TIMEOUT_MS;
		const isStale = ageMs > phaseTimeout;

		if (!isStale) {
			return "active";
		}

		const staleThreshold = new Date(Date.now() - phaseTimeout);
		console.log(
			`[Get Status] Cleaning up stale upload record for video ${videoId} (phase: ${upload.phase}, age: ${Math.round(ageMs / 1000)}s)`,
		);
		await db()
			.delete(videoUploads)
			.where(
				and(
					eq(videoUploads.videoId, videoId),
					lt(videoUploads.updatedAt, staleThreshold),
				),
			);

		return "stale_cleaned";
	} catch (error) {
		console.error(
			`[Get Status] DB error checking active uploads for video ${videoId}:`,
			error,
		);
		return "none";
	}
}

function triggerTranscription(
	videoId: Video.VideoId,
	ownerId: string,
	normalizedAiGenerationStatus: AiGenerationStatus | null,
	metadata: VideoMetadata,
): VideoStatusResult {
	console.log(
		`[Get Status] Transcription not started for video ${videoId}, triggering transcription`,
	);
	try {
		transcribeVideo(videoId, ownerId).catch((error) => {
			console.error(
				`[Get Status] Error starting transcription for video ${videoId}:`,
				error,
			);
		});

		return buildStatusResponse(
			"PROCESSING",
			normalizedAiGenerationStatus,
			metadata,
			{
				transcriptionError: null,
				transcriptionProgress: null,
				transcriptionProgressStartedAt: null,
			},
		);
	} catch (error) {
		console.error(
			`[Get Status] Error triggering transcription for video ${videoId}:`,
			error,
		);
		return buildStatusResponse(
			"ERROR",
			normalizedAiGenerationStatus,
			metadata,
			{
				error: "Failed to start transcription",
				transcriptionProgress: null,
				transcriptionError: "Failed to start transcription",
				transcriptionProgressStartedAt: null,
			},
		);
	}
}

async function triggerAiGenerationIfEligible(
	videoId: Video.VideoId,
	ownerId: string,
	normalizedTranscriptionStatus: TranscriptionStatus | null,
	normalizedAiGenerationStatus: AiGenerationStatus | null,
	metadata: VideoMetadata,
): Promise<VideoStatusResult | null> {
	try {
		const ownerQuery = await db()
			.select({
				email: users.email,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(users)
			.where(eq(users.id, ownerId))
			.limit(1);

		const owner = ownerQuery[0];
		if (owner && (await isAiGenerationEnabled(owner))) {
			const staleClaimThreshold = Date.now() - AI_GENERATION_CLAIM_TTL_MS;
			const claimResult = await db()
				.update(videos)
				.set({
					metadata: sql`JSON_SET(
						COALESCE(metadata, '{}'),
						'$.aiGenerationStatus', 'PROCESSING',
						'$.aiGenerationClaimedAt', ${Date.now()}
					)`,
				})
				.where(
					and(
						eq(videos.id, videoId),
						sql`(
							JSON_UNQUOTE(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationStatus')) IS NULL
							OR (
								JSON_UNQUOTE(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationStatus')) = 'PROCESSING'
								AND CAST(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationClaimedAt') AS UNSIGNED) < ${staleClaimThreshold}
							)
						)`,
					),
				);

			if (getAffectedRows(claimResult) === 0) {
				return buildStatusResponse(
					normalizedTranscriptionStatus,
					normalizedAiGenerationStatus,
					metadata,
					{
						transcriptionError: null,
					},
				);
			}

			console.log(
				`[Get Status] AI generation not started for video ${videoId}, triggering generation`,
			);
			generateAiWorkflow({ videoId, userId: ownerId }).catch(async (error) => {
				if (
					error instanceof FatalError &&
					CONTROL_FLOW_FATAL_MESSAGES.includes(error.message)
				) {
					return;
				}
				console.error(
					`[Get Status] Error in AI generation workflow for video ${videoId}:`,
					error,
				);
				try {
					const freshQuery = await db()
						.select({ metadata: videos.metadata })
						.from(videos)
						.where(eq(videos.id, videoId));
					const freshMetadata =
						(freshQuery[0]?.metadata as VideoMetadata) || {};
					if (
						freshMetadata.aiGenerationStatus === "COMPLETE" ||
						(freshMetadata.summary && freshMetadata.chapters?.length)
					) {
						return;
					}
					await db()
						.update(videos)
						.set({
							metadata: {
								...freshMetadata,
								aiGenerationStatus: "ERROR",
								aiGenerationClaimedAt: null,
							},
						})
						.where(eq(videos.id, videoId));
				} catch (dbErr) {
					console.error(
						`[Get Status] Failed to set ERROR status for ${videoId}:`,
						dbErr,
					);
				}
			});

			return buildStatusResponse(
				normalizedTranscriptionStatus,
				"PROCESSING" as AiGenerationStatus,
				metadata,
				{
					transcriptionError: null,
				},
			);
		}
	} catch (error) {
		console.error(
			`[Get Status] Error checking AI generation eligibility for video ${videoId}:`,
			error,
		);
	}

	return null;
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

	const normalizedTranscriptionStatus = isValidTranscriptionStatus(
		video.transcriptionStatus,
	)
		? (video.transcriptionStatus as TranscriptionStatus)
		: null;

	const normalizedAiGenerationStatus = isValidAiGenerationStatus(
		metadata.aiGenerationStatus,
	)
		? (metadata.aiGenerationStatus as AiGenerationStatus)
		: null;

	if (!normalizedTranscriptionStatus && serverEnv().GOOGLE_API_KEY) {
		const uploadStatus = await checkActiveUploads(videoId);

		if (uploadStatus === "active") {
			return buildStatusResponse(null, normalizedAiGenerationStatus, metadata, {
				transcriptionProgress: null,
				transcriptionError: null,
				transcriptionProgressStartedAt: null,
			});
		}

		return triggerTranscription(
			videoId,
			video.ownerId,
			normalizedAiGenerationStatus,
			metadata,
		);
	}

	if (normalizedTranscriptionStatus === "ERROR") {
		return buildStatusResponse(
			"ERROR",
			normalizedAiGenerationStatus,
			metadata,
			{
				error: metadata.transcriptionError || "Transcription failed",
				transcriptionProgress: null,
				transcriptionError: metadata.transcriptionError ?? null,
				transcriptionProgressStartedAt: null,
			},
		);
	}

	const hasCompleteAiMetadata =
		Boolean(metadata.summary) && Boolean(metadata.chapters?.length);
	const shouldTriggerAiGeneration =
		normalizedTranscriptionStatus === "COMPLETE" &&
		!normalizedAiGenerationStatus &&
		!hasCompleteAiMetadata &&
		serverEnv().GOOGLE_API_KEY;

	if (shouldTriggerAiGeneration) {
		const aiResult = await triggerAiGenerationIfEligible(
			videoId,
			video.ownerId,
			normalizedTranscriptionStatus,
			normalizedAiGenerationStatus,
			metadata,
		);
		if (aiResult) return aiResult;
	}

	return buildStatusResponse(
		normalizedTranscriptionStatus,
		normalizedAiGenerationStatus,
		metadata,
	);
}
```

### `apps/web/lib/generate-ai.ts`

```typescript
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { generateAiWorkflow } from "@/workflows/generate-ai";

type GenerateAiResult = {
	success: boolean;
	message: string;
};

export async function startAiGeneration(
	videoId: Video.VideoId,
	userId: string,
): Promise<GenerateAiResult> {
	if (!serverEnv().GOOGLE_API_KEY) {
		return {
			success: false,
			message: "Missing GOOGLE_API_KEY for Gemini AI generation",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video does not exist" };
	}

	const { video } = query[0];

	if (video.transcriptionStatus !== "COMPLETE") {
		return {
			success: false,
			message: "Transcription not complete",
		};
	}

	const metadata = (video.metadata as VideoMetadata) || {};

	if (
		metadata.aiGenerationStatus === "PROCESSING" ||
		metadata.aiGenerationStatus === "QUEUED"
	) {
		return {
			success: true,
			message: "AI generation already in progress",
		};
	}

	if (
		metadata.aiGenerationStatus === "COMPLETE" &&
		metadata.summary &&
		metadata.chapters
	) {
		return {
			success: true,
			message: "AI metadata already generated",
		};
	}

	try {
		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "QUEUED",
				},
			})
			.where(eq(videos.id, videoId));

		generateAiWorkflow({ videoId, userId }).catch(async (err) => {
			console.error(`[generateAi] Workflow failed for ${videoId}:`, err);
			try {
				const freshQuery = await db()
					.select({ metadata: videos.metadata })
					.from(videos)
					.where(eq(videos.id, videoId));
				const freshMetadata =
					(freshQuery[0]?.metadata as VideoMetadata) || {};
				if (freshMetadata.aiGenerationStatus === "COMPLETE") {
					return;
				}
				await db()
					.update(videos)
					.set({
						metadata: {
							...freshMetadata,
							aiGenerationStatus: "ERROR",
							aiGenerationClaimedAt: null,
						},
					})
					.where(eq(videos.id, videoId));
			} catch (dbErr) {
				console.error(
					`[generateAi] Failed to set ERROR status for ${videoId}:`,
					dbErr,
				);
			}
		});

		return {
			success: true,
			message: "AI generation workflow started",
		};
	} catch {
		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId));

		return {
			success: false,
			message: "Failed to start AI generation workflow",
		};
	}
}
```

### `apps/web/workflows/generate-ai.ts`

```typescript
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
export class FatalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FatalError";
	}
}
import { GEMINI_TEXT_MODEL, getGeminiClient } from "@/lib/gemini-client";
import { runPromise } from "@/lib/server";

interface GenerateAiWorkflowPayload {
	videoId: string;
	userId: string;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	bucketId: S3Bucket.S3BucketId | null;
	metadata: VideoMetadata;
}

interface VttSegment {
	start: number;
	text: string;
}

interface TranscriptData {
	segments: VttSegment[];
	text: string;
}

interface AiResult {
	title?: string;
	summary?: string;
	chapters?: { title: string; start: number }[];
}

const MAX_CHARS_PER_CHUNK = 24000;

export const CONTROL_FLOW_FATAL_MESSAGES = [
	"AI metadata already generated",
	"Transcription not complete",
];

export async function generateAiWorkflow(payload: GenerateAiWorkflowPayload) {
	const { videoId, userId } = payload;

	try {
		const videoData = await validateAndSetProcessing(videoId);

		const transcript = await fetchTranscript(
			videoId,
			userId,
			videoData.bucketId,
		);

		if (!transcript) {
			await markSkipped(videoId, videoData.metadata);
			return {
				success: true,
				message: "Transcript empty or too short - skipped",
			};
		}

		const result = await generateWithAi(transcript);

		await saveResults(videoId, videoData, result);

		return { success: true, message: "AI generation completed successfully" };
	} catch (error) {
		if (
			error instanceof FatalError &&
			CONTROL_FLOW_FATAL_MESSAGES.includes(error.message)
		) {
			throw error;
		}
		console.error(
			`[generateAiWorkflow] Unhandled error for video ${videoId}:`,
			error,
		);
		try {
			const freshQuery = await db()
				.select({ metadata: videos.metadata })
				.from(videos)
				.where(eq(videos.id, videoId as Video.VideoId));
			const freshMetadata =
				(freshQuery[0]?.metadata as VideoMetadata) || {};
			if (freshMetadata.aiGenerationStatus !== "COMPLETE") {
				await db()
					.update(videos)
					.set({
						metadata: {
							...freshMetadata,
							aiGenerationStatus: "ERROR",
						},
					})
					.where(eq(videos.id, videoId as Video.VideoId));
			}
		} catch (dbErr) {
			console.error(
				`[generateAiWorkflow] Failed to set ERROR status for ${videoId}:`,
				dbErr,
			);
		}
		throw error;
	}
}

async function validateAndSetProcessing(videoId: string): Promise<VideoData> {
	const gemini = getGeminiClient();
	if (!gemini) {
		throw new FatalError("Missing GOOGLE_API_KEY for Gemini");
	}

	const query = await db()
		.select({ video: videos, bucket: s3Buckets })
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0 || !query[0]?.video) {
		throw new FatalError("Video does not exist");
	}

	const { video, bucket } = query[0];
	const metadata = (video.metadata as VideoMetadata) || {};

	if (video.transcriptionStatus !== "COMPLETE") {
		throw new FatalError("Transcription not complete");
	}

	if (metadata.summary && metadata.chapters?.length) {
		throw new FatalError("AI metadata already generated");
	}

	await db()
		.update(videos)
		.set({
			metadata: {
				...metadata,
				aiGenerationStatus: "PROCESSING",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video,
		bucketId: (bucket?.id ?? null) as S3Bucket.S3BucketId | null,
		metadata,
	};
}

async function fetchTranscript(
	videoId: string,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<TranscriptData | null> {
	const vtt = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		);
		return yield* bucket.getObject(`${userId}/${videoId}/transcription.vtt`);
	}).pipe(runPromise);

	if (Option.isNone(vtt)) {
		return null;
	}

	const segments = parseVttWithTimestamps(vtt.value);
	const text = segments
		.map((s) => s.text)
		.join(" ")
		.trim();

	if (text.length < 10) {
		return null;
	}

	return { segments, text };
}

async function markSkipped(
	videoId: string,
	metadata: VideoMetadata,
): Promise<void> {
	await db()
		.update(videos)
		.set({
			metadata: {
				...metadata,
				aiGenerationStatus: "SKIPPED",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function generateWithAi(transcript: TranscriptData): Promise<AiResult> {
	const chunks = chunkTranscriptWithTimestamps(transcript.segments);

	if (chunks.length === 1) {
		return generateSingleChunk(transcript.text);
	}

	return generateMultipleChunks(chunks);
}

async function saveResults(
	videoId: string,
	videoData: VideoData,
	result: AiResult,
): Promise<void> {
	const { video, metadata } = videoData;

	const updatedMetadata: VideoMetadata = {
		...metadata,
		aiTitle: result.title || metadata.aiTitle,
		summary: result.summary || metadata.summary,
		chapters: result.chapters || metadata.chapters,
		aiGenerationStatus: "COMPLETE",
	};

	await db()
		.update(videos)
		.set({ metadata: updatedMetadata })
		.where(eq(videos.id, videoId as Video.VideoId));

	const hasDatePattern = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(
		video.name || "",
	);

	if (
		(video.name?.startsWith("Cap Recording -") || hasDatePattern) &&
		result.title
	) {
		await db()
			.update(videos)
			.set({ name: result.title })
			.where(eq(videos.id, videoId as Video.VideoId));
	}
}

function parseVttWithTimestamps(vttContent: string): VttSegment[] {
	const lines = vttContent.split("\n");
	const segments: VttSegment[] = [];
	let currentStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		if (line.includes("-->")) {
			const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
			if (timeMatch) {
				currentStart =
					parseInt(timeMatch[1] ?? "0", 10) * 3600 +
					parseInt(timeMatch[2] ?? "0", 10) * 60 +
					parseInt(timeMatch[3] ?? "0", 10);
			}
		} else if (
			line &&
			line !== "WEBVTT" &&
			!/^\d+$/.test(line) &&
			!line.includes("-->")
		) {
			segments.push({ start: currentStart, text: line });
		}
	}

	return segments;
}

function chunkTranscriptWithTimestamps(
	segments: VttSegment[],
): { text: string; startTime: number; endTime: number }[] {
	const chunks: { text: string; startTime: number; endTime: number }[] = [];
	let currentChunk: VttSegment[] = [];
	let currentLength = 0;

	for (const segment of segments) {
		if (
			currentLength + segment.text.length > MAX_CHARS_PER_CHUNK &&
			currentChunk.length > 0
		) {
			chunks.push({
				text: currentChunk.map((s) => s.text).join(" "),
				startTime: currentChunk[0]?.start ?? 0,
				endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
			});
			currentChunk = [];
			currentLength = 0;
		}
		currentChunk.push(segment);
		currentLength += segment.text.length + 1;
	}

	if (currentChunk.length > 0) {
		chunks.push({
			text: currentChunk.map((s) => s.text).join(" "),
			startTime: currentChunk[0]?.start ?? 0,
			endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
		});
	}

	return chunks;
}

async function callGemini(prompt: string): Promise<string> {
	const gemini = getGeminiClient();
	if (!gemini) {
		return "{}";
	}

	const model = gemini.getGenerativeModel({ model: GEMINI_TEXT_MODEL });
	const result = await model.generateContent(prompt);
	return result.response.text() || "{}";
}

function cleanJsonResponse(content: string): string {
	if (content.includes("```json")) {
		return content.replace(/```json\s*/g, "").replace(/```\s*/g, "");
	}
	if (content.includes("```")) {
		return content.replace(/```\s*/g, "");
	}
	return content;
}

async function generateSingleChunk(
	transcriptText: string,
): Promise<AiResult> {
	const prompt = `You are Cap AI, an expert at analyzing video content and creating comprehensive summaries.

Analyze this transcript thoroughly and provide a detailed JSON response:
{
  "title": "string (concise but descriptive title that captures the main topic)",
  "summary": "string (detailed summary that covers ALL key points discussed. For meetings: include decisions made, action items, and key discussion points. For tutorials: cover all steps and concepts explained. For presentations: summarize all main arguments and supporting points. Write from 1st person perspective if the speaker is teaching/presenting, e.g. 'In this video, I walk through...'. Make it comprehensive enough that someone could understand the full content without watching.)",
  "chapters": [{"title": "string (descriptive chapter title)", "start": number (seconds from start)}]
}

Guidelines:
- The summary should be detailed and comprehensive, not a brief overview
- Capture ALL important topics, not just the main theme
- For longer content, organize the summary by topic or chronologically
- Include specific details, names, numbers, and conclusions mentioned
- Chapters should mark distinct topic changes or sections

Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript:
${transcriptText}`;

	const content = await callGemini(prompt);
	return parseAiResponse(content);
}

async function generateMultipleChunks(
	chunks: { text: string; startTime: number; endTime: number }[],
): Promise<AiResult> {
	const chunkSummaries: {
		summary: string;
		keyPoints: string[];
		chapters: { title: string; start: number }[];
		startTime: number;
		endTime: number;
	}[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;

		const chunkPrompt = `You are Cap AI, an expert at analyzing video content. This is section ${i + 1} of ${chunks.length} from a longer video (timestamp ${Math.floor(chunk.startTime / 60)}:${String(chunk.startTime % 60).padStart(2, "0")} to ${Math.floor(chunk.endTime / 60)}:${String(chunk.endTime % 60).padStart(2, "0")}).

Analyze this section thoroughly and provide JSON:
{
  "summary": "string (detailed summary of this section - capture ALL key points, topics discussed, decisions made, or concepts explained. Include specific details like names, numbers, action items, and conclusions. This should be 3-6 sentences minimum.)",
  "keyPoints": ["string (specific key point or takeaway)", ...],
  "chapters": [{"title": "string (descriptive title for this topic/section)", "start": number (seconds from video start)}]
}

Be thorough - this summary will be combined with other sections to create a comprehensive overview.
Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript section:
${chunk.text}`;

		const chunkContent = await callGemini(chunkPrompt);
		try {
			const parsed = JSON.parse(cleanJsonResponse(chunkContent).trim());
			chunkSummaries.push({
				summary: parsed.summary || "",
				keyPoints: parsed.keyPoints || [],
				chapters: parsed.chapters || [],
				startTime: chunk.startTime,
				endTime: chunk.endTime,
			});
		} catch {}
	}

	const allChapters: { title: string; start: number }[] = [];
	const sortedChapters = chunkSummaries
		.flatMap((c) => c.chapters)
		.sort((a, b) => a.start - b.start);
	for (const chapter of sortedChapters) {
		const lastChapter = allChapters[allChapters.length - 1];
		if (!lastChapter || Math.abs(chapter.start - lastChapter.start) >= 30) {
			allChapters.push(chapter);
		}
	}

	const allKeyPoints = chunkSummaries.flatMap((c) => c.keyPoints);

	const sectionDetails = chunkSummaries
		.map((c, i) => {
			const timeRange = `${Math.floor(c.startTime / 60)}:${String(c.startTime % 60).padStart(2, "0")} - ${Math.floor(c.endTime / 60)}:${String(c.endTime % 60).padStart(2, "0")}`;
			const keyPointsList =
				c.keyPoints.length > 0 ? `\nKey points: ${c.keyPoints.join("; ")}` : "";
			return `Section ${i + 1} (${timeRange}):\n${c.summary}${keyPointsList}`;
		})
		.join("\n\n");

	const finalPrompt = `You are Cap AI, an expert at synthesizing information into comprehensive, well-organized summaries.

Based on these detailed section analyses of a video, create a thorough final summary that captures EVERYTHING important.

Section analyses:
${sectionDetails}

${allKeyPoints.length > 0 ? `All key points identified:\n${allKeyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n` : ""}

Provide JSON in the following format:
{
  "title": "string (concise but descriptive title that captures the main topic/purpose)",
  "summary": "string (COMPREHENSIVE summary that covers the entire video thoroughly. This should be detailed enough that someone could understand all the important content without watching. Include: main topics covered, key decisions or conclusions, important details mentioned, action items if any. Organize it logically - for meetings use topics/agenda items, for tutorials use steps/concepts, for presentations use main arguments. Write from 1st person perspective if appropriate. This should be several paragraphs for longer content.)"
}

The summary must be detailed and comprehensive - not a brief overview. Capture all the important information from every section.
Return ONLY valid JSON without any markdown formatting or code blocks.`;

	const finalContent = await callGemini(finalPrompt);
	try {
		const parsed = JSON.parse(cleanJsonResponse(finalContent).trim());
		return {
			title: parsed.title,
			summary: parsed.summary,
			chapters: allChapters,
		};
	} catch {
		const fallbackSummary = chunkSummaries
			.map((c, i) => `**Part ${i + 1}:** ${c.summary}`)
			.join("\n\n");
		const keyPointsSummary =
			allKeyPoints.length > 0
				? `\n\n**Key Points:**\n${allKeyPoints.map((p) => `- ${p}`).join("\n")}`
				: "";
		return {
			title: "Video Summary",
			summary: fallbackSummary + keyPointsSummary,
			chapters: allChapters,
		};
	}
}

function parseAiResponse(content: string): AiResult {
	try {
		const data = JSON.parse(cleanJsonResponse(content).trim());

		if (data.chapters && data.chapters.length > 0) {
			const sortedChapters = data.chapters.sort(
				(a: { start: number }, b: { start: number }) => a.start - b.start,
			);
			const dedupedChapters: { title: string; start: number }[] = [];
			for (const chapter of sortedChapters) {
				const lastChapter = dedupedChapters[dedupedChapters.length - 1];
				if (!lastChapter || Math.abs(chapter.start - lastChapter.start) >= 30) {
					dedupedChapters.push(chapter);
				}
			}
			data.chapters = dedupedChapters;
		}

		return {
			title: data.title,
			summary: data.summary,
			chapters: data.chapters,
		};
	} catch {
		return {
			title: "Generated Title",
			summary:
				"The AI was unable to generate a proper summary for this content.",
			chapters: [],
		};
	}
}
```

## Open Questions

- None. The fix is straightforward and isolated.

## Key Files

- `apps/web/actions/videos/get-status.ts` - Changed import to pull `FatalError` and `CONTROL_FLOW_FATAL_MESSAGES` from the workflow module; the `.catch()` handler in `triggerAiGenerationIfEligible` now skips the ERROR update for control-flow FatalErrors, reads fresh metadata before writing, and skips the write if the status is already COMPLETE or if summary and chapters already exist.
- `apps/web/lib/generate-ai.ts` - Added error recovery in the `.catch()` handler: reads fresh metadata from DB, guards against overwriting COMPLETE status, clears `aiGenerationClaimedAt`, and sets `aiGenerationStatus` to ERROR when the workflow fails.
- `apps/web/workflows/generate-ai.ts` - Exported `FatalError` class and `CONTROL_FLOW_FATAL_MESSAGES` constant so callers can apply control-flow guards. Wrapped the `generateAiWorkflow` body in a top-level try/catch that sets `aiGenerationStatus` to ERROR on any unhandled failure, then re-throws so callers still see the error. Control-flow FatalErrors are excluded from the ERROR update. The `validateAndSetProcessing` completeness check now requires a non-empty chapters array (`metadata.chapters?.length`) instead of truthiness.
