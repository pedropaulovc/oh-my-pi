import { truncateHeadBytes, truncateTailBytes } from "./streaming-output";

export const PROGRESS_PREVIEW_MAX_BYTES = 3_000;

export interface ProgressPreview {
	text?: string;
	head?: string;
	tail?: string;
	truncated: boolean;
}

/** Build one UTF-8-safe head/tail preview shared by broker transport and model delivery. */
export function buildProgressPreview(text: string, sourceTruncated = false): ProgressPreview {
	const fullBytes = Buffer.byteLength(text, "utf8");
	if (!sourceTruncated && fullBytes <= PROGRESS_PREVIEW_MAX_BYTES) {
		return { text, truncated: false };
	}
	const retainedBytes = Math.min(fullBytes, PROGRESS_PREVIEW_MAX_BYTES);
	const headBytes = Math.floor(retainedBytes / 2);
	const tailBytes = retainedBytes - headBytes;
	return {
		head: truncateHeadBytes(text, headBytes).text,
		tail: truncateTailBytes(text, tailBytes).text,
		truncated: true,
	};
}
