import {
    createBashToolDefinition,
    type ExtensionAPI,
    keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const bgTasks = (...parts: string[]) => pathToFileURL(join(
    homedir(),
    ".pi/agent/npm/node_modules/pi-bg-tasks/extensions/bg-tasks",
    ...parts,
)).href;

export default async function (pi: ExtensionAPI) {
    const [registry, lifecycle, bashTools, taskTools, ui] = await Promise.all([
        import(bgTasks("registry.ts")),
        import(bgTasks("lifecycle.ts")),
        import(bgTasks("tools-bash.ts")),
        import(bgTasks("tools-tasks.ts")),
        import(bgTasks("ui.ts")),
    ]);
    const reg = new registry.BgRegistry();
    const bash = {
        // Only a fallback: the tool resolves `ctx.cwd || cwd` per call, so the session
        // cwd wins and this matters solely if a call arrives without one.
        ...createBashToolDefinition(process.cwd()),
        renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
            const state = context.state as {
                startedAt?: number;
                endedAt?: number;
                interval?: NodeJS.Timeout;
            };

            if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
            if (isPartial && !state.interval) state.interval = setInterval(() => context.invalidate(), 1000);
            if (!isPartial || context.isError) {
                state.endedAt ??= Date.now();
                if (state.interval) clearInterval(state.interval);
                state.interval = undefined;
            }

            const elapsed = state.startedAt === undefined ? "" : ` ${seconds((state.endedAt ?? Date.now()) - state.startedAt)}`;
            if (isPartial) return new Text(theme.fg("warning", `Running…${elapsed}`), 0, 0);

            const output = result.content
                .filter((content: any) => content.type === "text")
                .map((content: any) => content.text)
                .join("\n");
            let text = context.isError
                ? theme.fg("error", output)
                : theme.fg("success", `Finished in${elapsed}`);

            if (!context.isError && expanded && output) {
                text += `\n${theme.fg("toolOutput", output)}`;
            } else if (!context.isError && output) {
                text += theme.fg("muted", ` (${keyHint("app.tools.expand", "show output")})`);
            }
            return new Text(text, 0, 0);
        },
    };

    bashTools.registerBashTool(pi, reg, bash);
    taskTools.registerTaskTools(pi, reg);
    ui.registerUi(pi, reg);

    pi.on("input", (event) => {
        if (event.streamingBehavior !== "steer" || reg.foreground.size === 0) return;
        for (const slot of reg.foreground.values()) slot.requestPause("steer");
        reg.foreground.clear();
    });

    pi.on("session_start", async () => {
        reg.nonInteractive = lifecycle.detectNonInteractive(process.argv, Boolean(process.stdin.isTTY));
        registry.sweepStaleLogs();
    });

    pi.on("session_shutdown", async () => {
        const kills: Promise<void>[] = [];
        for (const job of reg.jobs.values()) {
            if (job.status === "running") {
                kills.push(lifecycle.terminateJobSilently(reg, job, "session_shutdown"));
            }
        }
        await Promise.all(kills);
    });
}
