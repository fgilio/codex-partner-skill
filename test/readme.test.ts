import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repositoryDirectory = dirname(import.meta.dir);

/**
 * Each `bun <script>.ts` in the README's bash blocks, with the directory a
 * reader is in when they paste it. The blocks run in order in one shell, so
 * a `cd` in one block still holds in the next.
 */
function scriptsRunByReadme(
  markdown: string,
): { directory: string; script: string }[] {
  const blocks = [...markdown.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(
    (match) => match[1] ?? "",
  );
  const runs: { directory: string; script: string }[] = [];
  let directory = ".";

  for (const line of blocks.flatMap((block) => block.split("\n"))) {
    const command = line.replace(/#.*$/, "").trim();
    const cd = /^cd (\S+)$/.exec(command)?.[1];

    if (cd !== undefined) {
      directory = join(directory, cd);
      continue;
    }

    for (const match of command.matchAll(/(?:^|\s)bun (\S+\.ts)\b/g)) {
      runs.push({ directory, script: match[1] ?? "" });
    }
  }

  return runs;
}

describe("README", () => {
  test("every bun script command points at a file from where it runs", async () => {
    const readme = await Bun.file(
      join(repositoryDirectory, "README.md"),
    ).text();
    const runs = scriptsRunByReadme(readme);
    const missing = runs.filter(
      ({ directory, script }) =>
        !existsSync(resolve(repositoryDirectory, directory, script)),
    );

    expect(runs.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test("a cd in an earlier block holds for the later ones", () => {
    const markdown =
      "```bash\ncd token-worker\nbun scripts/seed.ts\n```\n\n```bash\nX=1 bun token-worker/scripts/status.ts\n```\n";

    expect(scriptsRunByReadme(markdown)).toEqual([
      { directory: "token-worker", script: "scripts/seed.ts" },
      { directory: "token-worker", script: "token-worker/scripts/status.ts" },
    ]);
  });
});
