---
created: 2026-04-09
system: cap
status: approved
content_hash: cad77a8e248c5629b18b76df71f871cfd68b8d461017894a87d164a3bf8f5235
target_agent: worktree
acceptance_criteria:
  - "Do all helper functions wrap DB operations in try/catch with graceful degradation?"
  - "Does buildStatusResponse validate transcriptionStatus against known values?"
  - "Does triggerTranscription clear stale error/progress metadata when returning PROCESSING?"
  - "Does triggerAiGenerationIfEligible check for existing PROCESSING status before triggering?"
depends_on:
  - PR8-sentrux-quality-extract-helpers-from-getvideostatus
supersedes:
repos:
  - Cap
---

# GetStatus Hardening

## Problem

Four pre-existing quality issues in `apps/web/actions/videos/get-status.ts` were surfaced by Codex during the sentrux refactor. The file was refactored in PR #8 to extract helper functions (`checkActiveUploads`, `triggerTranscription`, `triggerAiGenerationIfEligible`, `buildStatusResponse`), but these helpers lack error handling and validation. Transient DB errors in `checkActiveUploads` abort the entire request, corrupted transcription status values leak to clients, stale error metadata persists across transcription restarts, and concurrent polls can trigger duplicate AI generation jobs. Additionally, the AI generation metadata write uses a read-then-write spread pattern that can clobber concurrent metadata updates, and `startAiGeneration` failures leave the status stuck at PROCESSING with no rollback.

## Design

All fixes are contained within a single file (`apps/web/actions/videos/get-status.ts`). No schema changes, no new files, no new dependencies.

### Bug 1: DB error handling in helpers

Wrap `checkActiveUploads` DB operations (select and delete) in try/catch. On failure, return `"none"` so transcription can proceed rather than blocking the request. The stale-cleanup delete is already non-critical; if it fails, the next poll will retry.

`triggerAiGenerationIfEligible` already has a try/catch around its DB call and returns `null` on failure. No change needed there beyond what PR #8 already provides. The outer catch already logs and continues.

`triggerTranscription` is synchronous and its existing try/catch handles the `transcribeVideo` call. The `transcribeVideo` call is fire-and-forget (`.catch()` handler), so errors are already caught. No additional wrapping needed for this helper.

The primary fix is `checkActiveUploads`, which has two unwrapped awaited DB calls.

### Bug 2: TranscriptionStatus and AiGenerationStatus validation

Add a `VALID_TRANSCRIPTION_STATUSES` constant and a type guard `isValidTranscriptionStatus`. Use it in `buildStatusResponse` to validate the `transcriptionStatus` parameter before including it in the response. If the value is not a known status, treat it as `null`.

Add a `VALID_AI_GENERATION_STATUSES` constant and a type guard `isValidAiGenerationStatus`. Use it in `buildStatusResponse` to validate the `aiGenerationStatus` from metadata before including it in the response. If the value is not a known status, treat it as `null`.

### Bug 3: Stale metadata on transcription restart

When `triggerTranscription` returns a PROCESSING status, override `transcriptionError`, `transcriptionProgress`, and `transcriptionProgressStartedAt` to `null` via the overrides parameter of `buildStatusResponse`. This prevents stale failure data from a previous attempt from showing alongside the new PROCESSING status.

### Bug 4: AI generation race condition, metadata clobber, and failure rollback

Three related problems in `triggerAiGenerationIfEligible`:

**Race condition (AI-RACE-001):** The previous spec used a read-then-write pattern: read metadata, check if PROCESSING/QUEUED, then write PROCESSING. Two concurrent requests can both read null and both trigger `startAiGeneration`. Fix: use a single atomic SQL UPDATE with `JSON_SET` and a WHERE clause that only matches if `aiGenerationStatus` is NOT already PROCESSING or QUEUED. Check `affectedRows` on the result: if zero rows were affected, another request already claimed the lock, so skip `startAiGeneration`.

**Metadata clobber (AI-META-002):** The previous spec used `{...metadata, aiGenerationStatus: "PROCESSING"}` which reads the full metadata object, spreads it, and writes back. Any concurrent metadata updates between the read and write get overwritten. Fix: use SQL `JSON_SET` to atomically update only the `aiGenerationStatus` field without touching other metadata fields. This is the same `JSON_SET` used for the race fix above.

**Stuck PROCESSING on failure (AI-STUCK-003):** If `startAiGeneration` throws, `aiGenerationStatus` stays PROCESSING permanently. Fix: in the `.catch()` handler for `startAiGeneration`, reset `aiGenerationStatus` to null using `JSON_SET(COALESCE(metadata, '{}'), '$.aiGenerationStatus', CAST(NULL AS JSON))`. This allows a future poll to retry.

## Acceptance Criteria

- [ ] Do all helper functions wrap DB operations in try/catch with graceful degradation?
- [ ] Does buildStatusResponse validate transcriptionStatus against known values?
- [ ] Does triggerTranscription clear stale error/progress metadata when returning PROCESSING?
- [ ] Does triggerAiGenerationIfEligible check for existing PROCESSING status before triggering?

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
import { startAiGeneration } from "@/lib/generate-ai";
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

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

function buildStatusResponse(
	transcriptionStatus: string | null,
	metadata: VideoMetadata,
	overrides?: Partial<VideoStatusResult>,
): VideoStatusResult {
	const validatedTranscription = isValidTranscriptionStatus(
		transcriptionStatus,
	)
		? transcriptionStatus
		: null;

	const validatedAiGeneration = isValidAiGenerationStatus(
		metadata.aiGenerationStatus,
	)
		? metadata.aiGenerationStatus
		: null;

	return {
		transcriptionStatus: validatedTranscription,
		aiGenerationStatus: validatedAiGeneration,
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

		return buildStatusResponse("PROCESSING", metadata, {
			transcriptionError: null,
			transcriptionProgress: null,
			transcriptionProgressStartedAt: null,
		});
	} catch (error) {
		console.error(
			`[Get Status] Error triggering transcription for video ${videoId}:`,
			error,
		);
		return buildStatusResponse("ERROR", metadata, {
			error: "Failed to start transcription",
			transcriptionProgress: null,
			transcriptionError: "Failed to start transcription",
			transcriptionProgressStartedAt: null,
		});
	}
}

async function triggerAiGenerationIfEligible(
	videoId: Video.VideoId,
	ownerId: string,
	transcriptionStatus: string | null,
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
			const claimResult = await db()
				.update(videos)
				.set({
					metadata: sql`JSON_SET(COALESCE(metadata, '{}'), '$.aiGenerationStatus', 'PROCESSING')`,
				})
				.where(
					and(
						eq(videos.id, videoId),
						sql`(JSON_UNQUOTE(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationStatus')) IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationStatus')) NOT IN ('PROCESSING', 'QUEUED'))`,
					),
				);

			if (getAffectedRows(claimResult) === 0) {
				return buildStatusResponse(transcriptionStatus, metadata, {
					transcriptionError: null,
				});
			}

			console.log(
				`[Get Status] AI generation not started for video ${videoId}, triggering generation`,
			);
			startAiGeneration(videoId, ownerId).catch(async (error) => {
				console.error(
					`[Get Status] Error starting AI generation for video ${videoId}:`,
					error,
				);
				await db()
					.update(videos)
					.set({
						metadata: sql`JSON_SET(COALESCE(metadata, '{}'), '$.aiGenerationStatus', CAST(NULL AS JSON))`,
					})
					.where(eq(videos.id, videoId))
					.catch(() => {});
			});

			return buildStatusResponse(transcriptionStatus, metadata, {
				aiGenerationStatus: "PROCESSING" as AiGenerationStatus,
				transcriptionError: null,
			});
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

	if (!video.transcriptionStatus && serverEnv().GOOGLE_API_KEY) {
		const uploadStatus = await checkActiveUploads(videoId);

		if (uploadStatus === "active") {
			return buildStatusResponse(null, metadata, {
				transcriptionProgress: null,
				transcriptionError: null,
				transcriptionProgressStartedAt: null,
			});
		}

		return triggerTranscription(videoId, video.ownerId, metadata);
	}

	if (video.transcriptionStatus === "ERROR") {
		return buildStatusResponse("ERROR", metadata, {
			error: metadata.transcriptionError || "Transcription failed",
			transcriptionProgress: null,
			transcriptionError: metadata.transcriptionError ?? null,
			transcriptionProgressStartedAt: null,
		});
	}

	const shouldTriggerAiGeneration =
		video.transcriptionStatus === "COMPLETE" &&
		!metadata.aiGenerationStatus &&
		!metadata.summary &&
		(serverEnv().GROQ_API_KEY || serverEnv().OPENAI_API_KEY);

	if (shouldTriggerAiGeneration) {
		const aiResult = await triggerAiGenerationIfEligible(
			videoId,
			video.ownerId,
			video.transcriptionStatus,
			metadata,
		);
		if (aiResult) return aiResult;
	}

	return buildStatusResponse(video.transcriptionStatus, metadata);
}
```

## Open Questions

- The `startAiGeneration` function in `generate-ai.ts` also uses the read-then-write spread pattern (`{...metadata, aiGenerationStatus: "QUEUED"}`) when setting its own status. This is the same metadata clobber vulnerability (AI-META-002) but on the `generate-ai.ts` side. Fixing that file is out of scope for this spec since it would change the generate-ai module's contract, but it should be addressed in a follow-up.
- The atomic claim write sets `aiGenerationStatus` to `"PROCESSING"`, then `startAiGeneration` overwrites it to `"QUEUED"` via its own DB write. Both values cause the guard to skip, and the brief PROCESSING-to-QUEUED transition is not user-visible. However, if a future change to `startAiGeneration` removes its own QUEUED write, the status would remain PROCESSING permanently. This coupling should be documented if it becomes a concern.
- The `.catch()` rollback in `triggerAiGenerationIfEligible` resets `aiGenerationStatus` to null using `CAST(NULL AS JSON)`. This means a future poll could retry the generation. If `startAiGeneration` fails repeatedly, this creates a retry loop bounded only by the poll interval. Rate limiting or a retry counter could be added in a follow-up if this becomes a problem.

## Key Files

- `apps/web/actions/videos/get-status.ts` - Server action for video status polling. All four hardening fixes are in this file.
- `apps/web/lib/generate-ai.ts` - Called by `triggerAiGenerationIfEligible`. Has its own PROCESSING/QUEUED idempotency guard (defense-in-depth). Also uses the spread pattern for metadata writes (out of scope).
- `apps/web/lib/video-processing.ts` - Contains the `getAffectedRows` helper pattern used as reference for the new helper in this file.
- `packages/database/types/metadata.ts` - Defines `VideoMetadata` interface (unchanged).
- `packages/database/schema.ts` - Defines `transcriptionStatus` enum on the videos table (unchanged).
