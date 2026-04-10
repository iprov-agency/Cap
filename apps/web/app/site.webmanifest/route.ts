import { NextResponse } from "next/server";

const manifest = {
	name: "Cap",
	short_name: "Cap",
	icons: [
		{
			src: "/android-chrome-192x192.png",
			sizes: "192x192",
			type: "image/png",
		},
		{
			src: "/android-chrome-512x512.png",
			sizes: "512x512",
			type: "image/png",
		},
	],
	theme_color: "#ffffff",
	background_color: "#ffffff",
	display: "standalone",
};

export function GET() {
	return NextResponse.json(manifest, {
		headers: {
			"Content-Type": "application/manifest+json",
			"Cache-Control": "public, max-age=86400",
		},
	});
}
