import { describe, expect, it } from "bun:test";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { transcriptText } from "./helpers/transcript-text";

describe("dogfood update notice", () => {
	it("renders the product's update command without directing dogfood users to the official updater", () => {
		for (const appName of [APP_NAME, `${APP_NAME}-dogfood`]) {
			const ctx = createInteractiveModeContext();
			new UiHelpers(ctx).showNewVersionNotification("1.2.3", appName);
			const output = transcriptText(ctx.shell, 100);
			expect(output).toContain(`New version 1.2.3 is available. Run: ${appName} update`);
			if (appName !== APP_NAME) expect(output).not.toContain(`Run: ${APP_NAME} update`);
		}
	});
});
