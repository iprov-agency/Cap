---
created: 2026-04-09
system: cap
status: approved
content_hash: 910b2c9955e548af4758a95a47cda153c49f02a91f18acd07bcf5ea5f063261a
target_agent: worktree
acceptance_criteria:
  - "Is getVideoStatus under 120 lines after extraction?"
  - "Are extracted helper functions each under 80 lines and cc < 30?"
  - "Does the refactored code preserve identical behavior (same return values, same side effects)?"
  - "Does fan-out of getVideoStatus decrease compared to the original?"
  - "Do all exported types and the function signature remain unchanged?"
depends_on:
supersedes:
repos:
  - Cap
---

# Sentrux Quality: Extract Helpers from getVideoStatus

## Problem

`apps/web/actions/videos/get-status.ts` has a single 197-line function `getVideoStatus` with cyclomatic complexity of 49. The function handles five distinct responsibilities: upload status checking, stale upload cleanup, transcription triggering, AI generation triggering, and response assembly. The response object (9 fields) is constructed identically in 6 separate return paths with only minor overrides. This violates the sentrux `max_cc=30` constraint and makes the function difficult to maintain. Extracting focused helpers will bring the main function under 120 lines, reduce cc below 30, and eliminate the duplicated response construction.

## Design

Extract four private helper functions from `getVideoStatus`, all in the same file:

1. **`buildStatusResponse`** accepts the video's `transcriptionStatus`, the `VideoMetadata` object, and an optional overrides object. Returns a `VideoStatusResult`. This eliminates the 6 duplicated response constructions (each 8-10 lines) with a single function call plus overrides.

2. **`checkActiveUploads`** accepts a `videoId`, queries the `videoUploads` table for active upload phases, checks staleness using `PHASE_STALE_TIMEOUTS`, and cleans up stale records. Returns `"active" | "stale_cleaned" | "none"` to communicate the result to the caller without leaking DB query details.

3. **`triggerTranscription`** accepts `videoId`, `ownerId`, and `metadata`, fires off the `transcribeVideo` call (fire-and-forget with error logging), and returns the appropriate `VideoStatusResult` indicating `PROCESSING` status. Catches synchronous errors and returns an `ERROR` response.

4. **`triggerAiGenerationIfEligible`** accepts `videoId`, `ownerId`, `transcriptionStatus`, and `metadata`. Queries for the video owner, checks AI generation eligibility, and fires off `startAiGeneration` if eligible. Returns a `VideoStatusResult` with `QUEUED` AI status and the passed-through transcription status if triggered, or `null` if not eligible. The `transcriptionStatus` parameter is required because this helper is called only when `video.transcriptionStatus === "COMPLETE"`, and the returned response must carry that value.

The main `getVideoStatus` function becomes an orchestrator: fetch video, check uploads, trigger transcription or AI generation, and return the response. Each branch is a single helper call instead of inline logic.

All helpers are private (not exported). The exported API surface (`getVideoStatus`, `VideoStatusResult` type, and all type aliases) remains identical. No behavior changes: same DB queries, same side effects, same return values for every code path.

## Acceptance Criteria

- [ ] Is getVideoStatus under 120 lines after extraction?
- [ ] Are extracted helper functions each under 80 lines and cc < 30?
- [ ] Does the refactored code preserve identical behavior (same return values, same side effects)?
- [ ] Does fan-out of getVideoStatus decrease compared to the original?
- [ ] Do all exported types and the function signature remain unchanged?

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
import { and, desc, eq, inArray, lt } from "drizzle-orm";
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

const PHASE_STALE_TIMEOUTS: Record<string, number> = {
	uploading: 5 * 60 * 1000,
	processing: 15 * 60 * 1000,
	generating_thumbnail: 10 * 60 * 1000,
};

const DEFAULT_STALE_TIMEOUT_MS = 5 * 60 * 1000;

function buildStatusResponse(
	transcriptionStatus: string | null,
	metadata: VideoMetadata,
	overrides?: Partial<VideoStatusResult>,
): VideoStatusResult {
	return {
		transcriptionStatus:
			(transcriptionStatus as TranscriptionStatus) || null,
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
		...overrides,
	};
}

async function checkActiveUploads(
	videoId: Video.VideoId,
): Promise<"active" | "stale_cleaned" | "none"> {
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

	const upload = activeUpload[0]!;
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

		return buildStatusResponse("PROCESSING", metadata);
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
				thirdPartyStripeSubscriptionId:
					users.thirdPartyStripeSubscriptionId,
			})
			.from(users)
			.where(eq(users.id, ownerId))
			.limit(1);

		const owner = ownerQuery[0];
		if (owner && (await isAiGenerationEnabled(owner))) {
			console.log(
				`[Get Status] AI generation not started for video ${videoId}, triggering generation`,
			);
			startAiGeneration(videoId, ownerId).catch((error) => {
				console.error(
					`[Get Status] Error starting AI generation for video ${videoId}:`,
					error,
				);
			});

			return buildStatusResponse(transcriptionStatus, metadata, {
				aiGenerationStatus: "QUEUED" as AiGenerationStatus,
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

- The `apps/web/app/s/[videoId]/page.tsx` file (fan-out=18) was evaluated for refactoring but excluded from this spec. Reducing its fan-out would require either creating barrel exports in shared packages (touching files outside the web app) or significantly restructuring the server component data-fetching logic. Both approaches carry risk that exceeds the "safe with minimal changes" threshold. A separate spec focused on share page data-fetching consolidation would be more appropriate.

## Key Files

- `apps/web/actions/videos/get-status.ts` - the only file changed; helper extraction within the same module
