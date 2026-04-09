---
created: 2026-04-09
system: cap
status: approved
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

Two additional high-severity issues were found during post-build review:

**Stranded PROCESSING claim (AI-STRAND-004):** The claim update sets `aiGenerationStatus` to PROCESSING via `JSON_SET` before `startAiGeneration` runs. If the process crashes between the DB update and the `startAiGeneration` call, the `.catch()` rollback never fires, and the status stays PROCESSING forever. The guard then blocks future retries. Fix: record an `aiGenerationClaimedAt` timestamp alongside the PROCESSING status. Before claiming, check if an existing PROCESSING claim is stale (older than 10 minutes). If stale, allow re-claim.

**Normalized status masking corruption (STATUS-NORM-005):** `buildStatusResponse` normalizes invalid statuses to null, but `getVideoStatus` still branches on raw DB values (`video.transcriptionStatus`, `metadata.aiGenerationStatus`). If the DB has a corrupted status, the client sees null forever while the server refuses to re-trigger because the raw value is truthy. Fix: normalize statuses once at the top of `getVideoStatus`, then use normalized values for all subsequent logic.

## Design

Fixes span two files: `apps/web/actions/videos/get-status.ts` (logic) and `packages/database/types/metadata.ts` (type addition).

### Bug 1: DB error handling in helpers

Wrap `checkActiveUploads` DB operations (select and delete) in try/catch. On failure, return `"none"` so transcription can proceed rather than blocking the request. The stale-cleanup delete is already non-critical; if it fails, the next poll will retry.

`triggerAiGenerationIfEligible` already has a try/catch around its DB call and returns `null` on failure. No change needed there beyond what PR #8 already provides. The outer catch already logs and continues.

`triggerTranscription` is synchronous and its existing try/catch handles the `transcribeVideo` call. The `transcribeVideo` call is fire-and-forget (`.catch()` handler), so errors are already caught. No additional wrapping needed for this helper.

The primary fix is `checkActiveUploads`, which has two unwrapped awaited DB calls.

### Bug 2: TranscriptionStatus and AiGenerationStatus validation

Add a `VALID_TRANSCRIPTION_STATUSES` constant and a type guard `isValidTranscriptionStatus`. Use it in `buildStatusResponse` to validate the `transcriptionStatus` parameter before including it in the response. If the value is not a known status, treat it as `null`.

Add a `VALID_AI_GENERATION_STATUSES` constant and a type guard `isValidAiGenerationStatus`. Use it in `buildStatusResponse` to validate the `aiGenerationStatus` from metadata before including it in the response. If the value is not a known status, treat it as `null`.

**Status normalization (CRITICAL):** Normalize statuses ONCE at the top of `getVideoStatus`, immediately after reading the video and metadata. The exact normalization code is:

```typescript
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
```

After this point, ALL subsequent code MUST use `normalizedTranscriptionStatus` and `normalizedAiGenerationStatus`. Zero references to `video.transcriptionStatus` or `metadata.aiGenerationStatus` may appear after the normalization point. Specifically:

1. The transcription trigger check uses `!normalizedTranscriptionStatus` (not `!video.transcriptionStatus`).
2. The ERROR branch checks `normalizedTranscriptionStatus === "ERROR"` (not `video.transcriptionStatus === "ERROR"`).
3. The `shouldTriggerAiGeneration` check compares `normalizedTranscriptionStatus === "COMPLETE"` and `!normalizedAiGenerationStatus` (not raw values).
4. `buildStatusResponse` receives `normalizedTranscriptionStatus` and `normalizedAiGenerationStatus` as typed parameters (signature: `TranscriptionStatus | null` and `AiGenerationStatus | null`), not raw strings.
5. `triggerTranscription` and `triggerAiGenerationIfEligible` receive normalized values as parameters.
6. The final return passes `normalizedTranscriptionStatus` and `normalizedAiGenerationStatus` to `buildStatusResponse`.

### Bug 3: Stale metadata on transcription restart

When `triggerTranscription` returns a PROCESSING status, override `transcriptionError`, `transcriptionProgress`, and `transcriptionProgressStartedAt` to `null` via the overrides parameter of `buildStatusResponse`. This prevents stale failure data from a previous attempt from showing alongside the new PROCESSING status.

### Bug 4: AI generation race condition, metadata clobber, failure rollback, and stale claim recovery

Four related problems in `triggerAiGenerationIfEligible`:

**Race condition (AI-RACE-001):** The previous spec used a read-then-write pattern: read metadata, check if PROCESSING/QUEUED, then write PROCESSING. Two concurrent requests can both read null and both trigger `startAiGeneration`. Fix: use a single atomic SQL UPDATE with `JSON_SET` and a WHERE clause that only succeeds when the claim is safe to make. Check `affectedRows` on the result: if zero rows were affected, another request already claimed the lock, so skip `startAiGeneration`.

**Metadata clobber (AI-META-002):** The previous spec used `{...metadata, aiGenerationStatus: "PROCESSING"}` which reads the full metadata object, spreads it, and writes back. Any concurrent metadata updates between the read and write get overwritten. Fix: use SQL `JSON_SET` to atomically update only the `aiGenerationStatus` field without touching other metadata fields. This is the same `JSON_SET` used for the race fix above.

**Stuck PROCESSING on failure (AI-STUCK-003):** If `startAiGeneration` throws, `aiGenerationStatus` stays PROCESSING permanently. Fix: in the `.catch()` handler for `startAiGeneration`, reset `aiGenerationStatus` to null using `JSON_SET(COALESCE(metadata, '{}'), '$.aiGenerationStatus', CAST(NULL AS JSON))`. This allows a future poll to retry.

**Stranded claim recovery (AI-STRAND-004):** If the process crashes between the atomic DB update and the `startAiGeneration` call, the `.catch()` never fires and the status stays PROCESSING forever. Fix: the `JSON_SET` claim now also writes `$.aiGenerationClaimedAt` with `Date.now()`. The WHERE clause adds an OR branch that allows re-claim when the existing PROCESSING claim is older than `AI_GENERATION_CLAIM_TTL_MS` (10 minutes). The `.catch()` rollback also clears `aiGenerationClaimedAt` alongside `aiGenerationStatus`. A new `aiGenerationClaimedAt` field is added to the `VideoMetadata` type.

**WHERE clause semantics (CRITICAL):** The atomic claim WHERE clause must ONLY allow the update to succeed in two cases:

1. `aiGenerationStatus` IS NULL (generation was never started).
2. `aiGenerationStatus` is PROCESSING AND `aiGenerationClaimedAt` is older than `AI_GENERATION_CLAIM_TTL_MS` (crashed worker recovery).

The claim MUST NOT succeed when `aiGenerationStatus` is COMPLETE, ERROR, QUEUED, or SKIPPED. A previous revision used `NOT IN ('PROCESSING', 'QUEUED')` which incorrectly allowed the claim to succeed on COMPLETE and ERROR, overwriting a finished generation. The corrected SQL condition is:

```sql
(
    JSON_UNQUOTE(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationStatus')) IS NULL
    OR (
        JSON_UNQUOTE(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationStatus')) = 'PROCESSING'
        AND CAST(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationClaimedAt') AS UNSIGNED) < ${staleClaimThreshold}
    )
)
```

## Acceptance Criteria

- [ ] Do all helper functions wrap DB operations in try/catch with graceful degradation?
- [ ] Does buildStatusResponse validate transcriptionStatus against known values?
- [ ] Does triggerTranscription clear stale error/progress metadata when returning PROCESSING?
- [ ] Does triggerAiGenerationIfEligible check for existing PROCESSING status before triggering?

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
	aiGenerationClaimedAt?: number;
	enhancedAudioStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";
	transcriptionStartedAt?: number;
	transcriptionProgress?: "EXTRACTING" | "TRANSCRIBING" | "SUMMARIZING";
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
			startAiGeneration(videoId, ownerId).catch(async (error) => {
				console.error(
					`[Get Status] Error starting AI generation for video ${videoId}:`,
					error,
				);
				await db()
					.update(videos)
					.set({
						metadata: sql`JSON_SET(COALESCE(metadata, '{}'), '$.aiGenerationStatus', CAST(NULL AS JSON), '$.aiGenerationClaimedAt', CAST(NULL AS JSON))`,
					})
					.where(eq(videos.id, videoId))
					.catch(() => {});
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

	const shouldTriggerAiGeneration =
		normalizedTranscriptionStatus === "COMPLETE" &&
		!normalizedAiGenerationStatus &&
		!metadata.summary &&
		(serverEnv().GROQ_API_KEY || serverEnv().OPENAI_API_KEY);

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

## Open Questions

- The `startAiGeneration` function in `generate-ai.ts` also uses the read-then-write spread pattern (`{...metadata, aiGenerationStatus: "QUEUED"}`) when setting its own status. This is the same metadata clobber vulnerability (AI-META-002) but on the `generate-ai.ts` side. Fixing that file is out of scope for this spec since it would change the generate-ai module's contract, but it should be addressed in a follow-up.
- The atomic claim write sets `aiGenerationStatus` to `"PROCESSING"`, then `startAiGeneration` overwrites it to `"QUEUED"` via its own DB write. Both values cause the guard to skip, and the brief PROCESSING-to-QUEUED transition is not user-visible. However, if a future change to `startAiGeneration` removes its own QUEUED write, the status would remain PROCESSING permanently. This coupling should be documented if it becomes a concern.
- The `.catch()` rollback in `triggerAiGenerationIfEligible` resets `aiGenerationStatus` to null using `CAST(NULL AS JSON)`. This means a future poll could retry the generation. If `startAiGeneration` fails repeatedly, this creates a retry loop bounded only by the poll interval. Rate limiting or a retry counter could be added in a follow-up if this becomes a problem.
- The stale claim recovery (AI-STRAND-004) uses a 10-minute TTL. If `startAiGeneration` legitimately takes longer than 10 minutes, a concurrent poll could re-claim and start a duplicate. In practice, AI generation should complete well within 10 minutes, so this threshold is conservative. If needed, it can be tuned or `startAiGeneration` can update `aiGenerationClaimedAt` as a heartbeat.
- The `startAiGeneration` spread pattern in `generate-ai.ts` will overwrite `aiGenerationClaimedAt` when it sets `{...metadata, aiGenerationStatus: "QUEUED"}`. This means the claimed-at timestamp is lost once `startAiGeneration` runs. However, this is acceptable because if `startAiGeneration` already ran, the process did not crash between the claim and the call, so the stranded-claim scenario does not apply. The stale-claim check only matters when the process crashed before `startAiGeneration` could run at all.

## Key Files

- `apps/web/actions/videos/get-status.ts` - Server action for video status polling. All hardening fixes plus stale-claim recovery and status normalization are in this file.
- `packages/database/types/metadata.ts` - Defines `VideoMetadata` interface. Added `aiGenerationClaimedAt` field.
- `apps/web/lib/generate-ai.ts` - Called by `triggerAiGenerationIfEligible`. Has its own PROCESSING/QUEUED idempotency guard (defense-in-depth). Also uses the spread pattern for metadata writes (out of scope).
- `apps/web/lib/video-processing.ts` - Contains the `getAffectedRows` helper pattern used as reference for the new helper in this file.
- `packages/database/schema.ts` - Defines `transcriptionStatus` enum on the videos table (unchanged).
