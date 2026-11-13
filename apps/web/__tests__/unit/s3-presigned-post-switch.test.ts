import { Organisation, User, Video } from "@cap/web-domain";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: { CAP_STORAGE_DISABLE_PRESIGNED_POST: false },
	getPresignedPutUrl: vi.fn(),
	getPresignedPostUrl: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => mocks.env,
}));

import { S3Buckets } from "../../../../packages/web-backend/src/S3Buckets";
import { Storage as StorageService } from "../../../../packages/web-backend/src/Storage";
import { StorageRepo } from "../../../../packages/web-backend/src/Storage/StorageRepo";

const key = "user-1/video-1/screenshot/screen-capture.png";

const video = new Video.Video({
	id: Video.VideoId.make("video-1"),
	ownerId: User.UserId.make("user-1"),
	orgId: Organisation.OrganisationId.make("org-1"),
	name: "Upload",
	public: false,
	source: { type: "webMP4" },
	metadata: Option.none(),
	bucketId: Option.none(),
	storageIntegrationId: Option.none(),
	folderId: Option.none(),
	transcriptionStatus: Option.none(),
	width: Option.none(),
	height: Option.none(),
	duration: Option.none(),
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const s3 = {
	bucketName: "bucket",
	isPathStyle: true,
	getPresignedPutUrl: mocks.getPresignedPutUrl,
	getPresignedPostUrl: mocks.getPresignedPostUrl,
};

const createUploadTarget = (input: {
	contentType: string;
	fields?: Record<string, string>;
	method?: "post" | "put";
}) => {
	const dependencies = Layer.merge(
		Layer.succeed(StorageRepo, {} as StorageRepo),
		Layer.succeed(S3Buckets, {
			getBucketAccess: () => Effect.succeed([s3, Option.none()] as const),
		} as unknown as S3Buckets),
	);
	return Effect.runPromise(
		StorageService.createUploadTargetForVideo(video, key, input).pipe(
			Effect.provide(
				StorageService.DefaultWithoutDependencies.pipe(
					Layer.provide(dependencies),
				),
			),
		),
	);
};

beforeEach(() => {
	mocks.env.CAP_STORAGE_DISABLE_PRESIGNED_POST = false;
	mocks.getPresignedPutUrl.mockReset();
	mocks.getPresignedPostUrl.mockReset();
	mocks.getPresignedPutUrl.mockReturnValue(
		Effect.succeed("https://s3.test/put"),
	);
	mocks.getPresignedPostUrl.mockReturnValue(
		Effect.succeed({ url: "https://s3.test/", fields: { key } }),
	);
});

describe("CAP_STORAGE_DISABLE_PRESIGNED_POST", () => {
	it("keeps presigned POST as the default when the switch is off", async () => {
		const upload = await createUploadTarget({
			contentType: "image/png",
			fields: { "x-amz-meta-userid": "user-1" },
		});

		expect(upload).toEqual({
			type: "s3Post",
			url: "https://s3.test/",
			fields: { key },
		});
		expect(mocks.getPresignedPutUrl).not.toHaveBeenCalled();
	});

	it.each([
		["omitted", undefined],
		["post", "post" as const],
	])(
		"hands out presigned PUT when the switch is on and method is %s",
		async (_label, method) => {
			mocks.env.CAP_STORAGE_DISABLE_PRESIGNED_POST = true;

			const upload = await createUploadTarget({
				contentType: "image/png",
				fields: { "x-amz-meta-userid": "user-1" },
				method,
			});

			expect(upload).toEqual({
				type: "put",
				url: "https://s3.test/put",
				headers: { "Content-Type": "image/png" },
			});
			expect(mocks.getPresignedPutUrl).toHaveBeenCalledWith(
				key,
				{ ContentType: "image/png" },
				{ expiresIn: 1800 },
			);
			expect(mocks.getPresignedPostUrl).not.toHaveBeenCalled();
		},
	);

	it("still honours an explicit PUT request when the switch is off", async () => {
		const upload = await createUploadTarget({
			contentType: "video/mp4",
			method: "put",
		});

		expect(upload.type).toBe("put");
		expect(mocks.getPresignedPostUrl).not.toHaveBeenCalled();
	});
});
