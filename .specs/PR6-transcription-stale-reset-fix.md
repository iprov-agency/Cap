---
created: 2026-04-09
system: cap
status: approved
content_hash: a1f340a38f86b58ec97d9cecbe85bde63a2bb2742cad409868ada3c3dcd32035
target_agent: worktree
acceptance_criteria:
  - "Is PROCESSING_TIMEOUT_MS set to 5 minutes (300000ms) instead of 2 minutes?"
  - "Does the stale PROCESSING handler set transcriptionStatus to ERROR with a transcriptionError message instead of resetting to null?"
  - "Does getVideoStatus only block transcription for active upload phases (uploading, processing, generating_thumbnail), not for complete or error?"
  - "Does the stale upload cleanup still work for uploads stuck in uploading phase?"
depends_on:
supersedes:
repos:
  - Cap
---

# Transcription Stale Reset Fix

## Problem

Four bugs discovered by adversarial review of PRs #2-5 on main cause duplicate transcription workflows, blocked transcription triggers, and stalled processing records.

Bug 1 (TSRF-001): In `apps/web/lib/transcribe.ts`, the stale PROCESSING check uses `Date.now() - startedAt` directly. The `transcriptionStartedAt` field is typed as `number` but could arrive as an ISO string or be missing at runtime. If it is a string, the subtraction yields NaN, which fails the comparison and causes the code to immediately fall through to resetting the status. If it is undefined, the guard passes but the behavior is fragile.

Bug 2 (TSRF-002): In `apps/web/lib/transcribe.ts`, the outer catch block (for synchronous errors when calling `transcribeVideoWorkflow`) resets `transcriptionStatus` to null. This re-enables the auto-trigger on every subsequent poll, creating an infinite retry loop.

Bug 3 (TSRF-003): In `apps/web/actions/videos/get-status.ts`, the upload record query uses `limit(1)` with no phase filter. If a "complete" row is returned while an active upload also exists, the JS-side phase check lets it through and incorrectly proceeds to trigger transcription (or conversely, the wrong row blocks transcription). The fix is to filter in SQL to only return active-phase rows.

Bug 4 (TSRF-004): In `apps/web/actions/videos/get-status.ts`, only "uploading" records get stale cleanup. Records stuck in "processing" or "generating_thumbnail" can stall indefinitely, permanently blocking transcription for that video.

## Design

### TSRF-001: Parse string timestamps in stale check

Parse `transcriptionStartedAt` to handle both numeric and string representations. If the parsed value is NaN or the field is missing entirely, treat the transcription as "in progress" (do not mark ERROR), because the absence of a valid timestamp means we cannot determine staleness.

### TSRF-002: Workflow-start failure sets ERROR, not null

When the synchronous call to `transcribeVideoWorkflow` throws, set `transcriptionStatus` to "ERROR" with a `transcriptionError` message in metadata. This prevents the poll-retrigger loop. Extract a `markTranscriptionError` helper to deduplicate the error-writing logic used by the stale handler, the async `.catch`, and the outer catch block.

### TSRF-003: SQL-level phase filtering for upload gating

Replace the `limit(1)` query that fetches any upload row with a query filtered to active phases (`uploading`, `processing`, `generating_thumbnail`) using `inArray`. Remove the JS-side phase check since SQL handles it.

### TSRF-004: Stale cleanup covers all active phases

Extend the stale upload cleanup to handle records stuck in any active phase (uploading, processing, generating_thumbnail), not just "uploading". All use the same 5-minute timeout.

## Acceptance Criteria

- [ ] Is PROCESSING_TIMEOUT_MS set to 5 minutes (300000ms) instead of 2 minutes?
- [ ] Does the stale PROCESSING handler set transcriptionStatus to ERROR with a transcriptionError message instead of resetting to null?
- [ ] Does getVideoStatus only block transcription for active upload phases (uploading, processing, generating_thumbnail), not for complete or error?
- [ ] Does the stale upload cleanup still work for uploads stuck in uploading phase?

## Implementation

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

const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

async function markTranscriptionError(
	videoId: Video.VideoId,
	errorMessage: string,
): Promise<void> {
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
}

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
		const rawStartedAt = metadata.transcriptionStartedAt;
		const startedAtMs =
			typeof rawStartedAt === "string"
				? Date.parse(rawStartedAt)
				: rawStartedAt;
		if (
			startedAtMs == null ||
			Number.isNaN(startedAtMs) ||
			Date.now() - startedAtMs < PROCESSING_TIMEOUT_MS
		) {
			return {
				success: true,
				message: "Transcription already in progress",
			};
		}
		console.log(
			`[transcribeVideo] PROCESSING status stale for ${videoId}, marking as ERROR`,
		);
		await markTranscriptionError(
			videoId,
			"Transcription timed out after 5 minutes. Click retry to try again.",
		);
		return {
			success: false,
			message:
				"Transcription timed out after 5 minutes. Click retry to try again.",
		};
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
				err instanceof Error
					? err.message
					: "Transcription failed unexpectedly";

			await markTranscriptionError(videoId, errorMessage);
		});

		return {
			success: true,
			message: "Transcription workflow started",
		};
	} catch (error) {
		console.error("[transcribeVideo] Failed to trigger workflow:", error);

		const errorMessage =
			error instanceof Error
				? error.message
				: "Failed to start transcription workflow";

		await markTranscriptionError(videoId, errorMessage);

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
import { and, eq, inArray } from "drizzle-orm";
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

const UPLOAD_STALE_TIMEOUT_MS = 5 * 60 * 1000;

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
			.where(
				and(
					eq(videoUploads.videoId, videoId),
					inArray(videoUploads.phase, [...ACTIVE_UPLOAD_PHASES]),
				),
			)
			.limit(1);

		if (activeUpload.length > 0) {
			const upload = activeUpload[0]!;
			const ageMs = Date.now() - new Date(upload.updatedAt).getTime();
			const isStale = ageMs > UPLOAD_STALE_TIMEOUT_MS;

			if (isStale) {
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

## Open Questions

- None. All four fixes are straightforward and isolated.

## Key Files

- `apps/web/lib/transcribe.ts` - Transcription orchestrator. Changed timeout from 2min to 5min, stale handler from null-reset to ERROR status, added string timestamp parsing with NaN guard, fixed outer catch block to set ERROR instead of null, extracted `markTranscriptionError` helper to deduplicate error-writing logic.
- `apps/web/actions/videos/get-status.ts` - Video status polling endpoint. Changed upload query to filter active phases in SQL via `inArray`, extended stale cleanup to all active phases (not just "uploading").
- `packages/database/types/metadata.ts` - VideoMetadata type (unchanged, already has `transcriptionError` and `transcriptionStartedAt` fields).
- `packages/database/schema.ts` - videoUploads schema (unchanged, phase type already includes all five phases).
