import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deployReviewedWorker,
  DeploymentError,
  reviewedDeploymentArguments,
  type DeploymentCommandOptions,
  type DeploymentCommandResult,
} from "./deploy-worker";

type Invocation = {
  executable: string;
  args: string[];
  options: DeploymentCommandOptions;
};

const SOURCE_COMMIT = "1234567890abcdef1234567890abcdef12345678";

function result(
  stdout = "",
  exitCode = 0,
  stderr = "",
): DeploymentCommandResult {
  return { exitCode, stdout, stderr };
}

function scriptedRunner(
  projectRoot: string,
  responses: DeploymentCommandResult[],
): {
  invocations: Invocation[];
  runner: (
    executable: string,
    args: string[],
    options: DeploymentCommandOptions,
  ) => Promise<DeploymentCommandResult>;
} {
  const invocations: Invocation[] = [];
  return {
    invocations,
    runner: async (executable, args, options) => {
      invocations.push({ executable, args, options });
      const next = responses.shift();
      return next ?? result("", 1, `unexpected command in ${projectRoot}`);
    },
  };
}

function successfulResponses(projectRoot: string): DeploymentCommandResult[] {
  return [
    result(`${projectRoot}\n`),
    result(`${SOURCE_COMMIT}\n`),
    result(""),
    result(),
    result(`${SOURCE_COMMIT}\n`),
    result(""),
    result(),
  ];
}

describe("reviewed Worker deployment", () => {
  it("owns the only npm deployment entry point", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.deploy).toBe("tsx scripts/deploy-worker.ts");
    expect(packageJson.scripts?.verify).toBe("npm test && npm run build");
  });

  it("injects the exact full HEAD automatically while preserving remote vars", async () => {
    const projectRoot = resolve("/private/tmp/music-library-deployment-test");
    const fake = scriptedRunner(projectRoot, successfulResponses(projectRoot));

    await expect(deployReviewedWorker(projectRoot, fake.runner)).resolves.toEqual({
      sourceCommit: SOURCE_COMMIT,
      message: `Deploy source ${SOURCE_COMMIT}`,
    });

    const deployed = fake.invocations.at(-1);
    expect(basename(deployed?.executable ?? "")).toBe("wrangler");
    expect(deployed?.args).toEqual(reviewedDeploymentArguments(SOURCE_COMMIT));
    expect(deployed?.args).toContain("--keep-vars");
    expect(deployed?.args).toContain(`SOURCE_COMMIT:${SOURCE_COMMIT}`);
    expect(deployed?.options).toEqual({
      cwd: projectRoot,
      inheritOutput: true,
    });
  });

  it.each([
    ["", "deployment_source_commit_invalid"],
    ["1234567", "deployment_source_commit_invalid"],
    ["1234567890ABCDEF1234567890ABCDEF12345678", "deployment_source_commit_invalid"],
    ["not-a-commit", "deployment_source_commit_invalid"],
  ])("rejects a missing or malformed Git commit (%j)", async (commit, code) => {
    const projectRoot = resolve("/private/tmp/music-library-deployment-test");
    const fake = scriptedRunner(projectRoot, [
      result(`${projectRoot}\n`),
      result(`${commit}\n`),
    ]);

    await expect(deployReviewedWorker(projectRoot, fake.runner))
      .rejects.toEqual(new DeploymentError(code));
    expect(fake.invocations.some(({ executable }) => basename(executable) === "wrangler"))
      .toBe(false);
  });

  it("refuses a dirty source tree before verification", async () => {
    const projectRoot = resolve("/private/tmp/music-library-deployment-test");
    const fake = scriptedRunner(projectRoot, [
      result(`${projectRoot}\n`),
      result(`${SOURCE_COMMIT}\n`),
      result(" M worker/index.ts\n"),
    ]);

    await expect(deployReviewedWorker(projectRoot, fake.runner))
      .rejects.toEqual(new DeploymentError("deployment_requires_clean_worktree"));
    expect(fake.invocations.some(({ executable, args }) => (
      executable === "npm" && args.join(" ") === "run verify"
    ))).toBe(false);
    expect(fake.invocations.some(({ executable }) => basename(executable) === "wrangler"))
      .toBe(false);
  });

  it("refuses to deploy when the source changes during verification", async () => {
    const projectRoot = resolve("/private/tmp/music-library-deployment-test");
    const changedCommit = "abcdef1234567890abcdef1234567890abcdef12";
    const fake = scriptedRunner(projectRoot, [
      result(`${projectRoot}\n`),
      result(`${SOURCE_COMMIT}\n`),
      result(""),
      result(),
      result(`${changedCommit}\n`),
      result(""),
    ]);

    await expect(deployReviewedWorker(projectRoot, fake.runner))
      .rejects.toEqual(new DeploymentError("deployment_source_changed_during_verification"));
    expect(fake.invocations.some(({ executable }) => basename(executable) === "wrangler"))
      .toBe(false);
  });

  it("stops before Wrangler when required verification fails", async () => {
    const projectRoot = resolve("/private/tmp/music-library-deployment-test");
    const fake = scriptedRunner(projectRoot, [
      result(`${projectRoot}\n`),
      result(`${SOURCE_COMMIT}\n`),
      result(""),
      result("", 1, "synthetic verification failure"),
    ]);

    await expect(deployReviewedWorker(projectRoot, fake.runner))
      .rejects.toEqual(new DeploymentError("deployment_verification_failed"));
    expect(fake.invocations.some(({ executable }) => basename(executable) === "wrangler"))
      .toBe(false);
  });
});
