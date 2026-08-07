import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type DeploymentCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type DeploymentCommandOptions = {
  cwd: string;
  inheritOutput: boolean;
};

export type DeploymentCommandRunner = (
  executable: string,
  args: string[],
  options: DeploymentCommandOptions,
) => Promise<DeploymentCommandResult>;

export type ReviewedDeployment = {
  sourceCommit: string;
  message: string;
};

export class DeploymentError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/u;

export function validDeploymentSourceCommit(value: string): boolean {
  return FULL_GIT_COMMIT.test(value);
}

export function reviewedDeploymentArguments(sourceCommit: string): string[] {
  if (!validDeploymentSourceCommit(sourceCommit)) {
    throw new DeploymentError("deployment_source_commit_invalid");
  }
  return [
    "deploy",
    "--keep-vars",
    "--var",
    `SOURCE_COMMIT:${sourceCommit}`,
    "--message",
    `Deploy source ${sourceCommit}`,
  ];
}

export const runDeploymentCommand: DeploymentCommandRunner = (
  executable,
  args,
  options,
) => new Promise((settle) => {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    shell: false,
    stdio: options.inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.once("error", (error) => {
    settle({
      exitCode: -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: error.message,
    });
  });
  child.once("close", (code) => {
    settle({
      exitCode: code ?? -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
  });
});

async function capturedCommand(
  runner: DeploymentCommandRunner,
  root: string,
  executable: string,
  args: string[],
  failureCode: string,
): Promise<string> {
  const result = await runner(executable, args, {
    cwd: root,
    inheritOutput: false,
  });
  if (result.exitCode !== 0) throw new DeploymentError(failureCode);
  return result.stdout.trim();
}

async function sourceSnapshot(
  runner: DeploymentCommandRunner,
  root: string,
): Promise<string> {
  const sourceCommit = await capturedCommand(
    runner,
    root,
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "deployment_source_commit_unavailable",
  );
  if (!validDeploymentSourceCommit(sourceCommit)) {
    throw new DeploymentError("deployment_source_commit_invalid");
  }
  const status = await capturedCommand(
    runner,
    root,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    "deployment_worktree_status_unavailable",
  );
  if (status !== "") throw new DeploymentError("deployment_requires_clean_worktree");
  return sourceCommit;
}

export async function deployReviewedWorker(
  root = resolve("."),
  runner: DeploymentCommandRunner = runDeploymentCommand,
): Promise<ReviewedDeployment> {
  const projectRoot = resolve(root);
  const gitRoot = await capturedCommand(
    runner,
    projectRoot,
    "git",
    ["rev-parse", "--show-toplevel"],
    "deployment_git_root_unavailable",
  );
  if (resolve(gitRoot) !== projectRoot) {
    throw new DeploymentError("deployment_must_run_from_project_root");
  }

  const sourceCommit = await sourceSnapshot(runner, projectRoot);
  const verification = await runner("npm", ["run", "verify"], {
    cwd: projectRoot,
    inheritOutput: true,
  });
  if (verification.exitCode !== 0) {
    throw new DeploymentError("deployment_verification_failed");
  }

  const postVerificationCommit = await sourceSnapshot(runner, projectRoot);
  if (postVerificationCommit !== sourceCommit) {
    throw new DeploymentError("deployment_source_changed_during_verification");
  }

  const args = reviewedDeploymentArguments(sourceCommit);
  const deployed = await runner(resolve(projectRoot, "node_modules/.bin/wrangler"), args, {
    cwd: projectRoot,
    inheritOutput: true,
  });
  if (deployed.exitCode !== 0) throw new DeploymentError("worker_deployment_failed");

  return {
    sourceCommit,
    message: `Deploy source ${sourceCommit}`,
  };
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new DeploymentError("deployment_cli_arguments_not_supported");
  }
  const result = await deployReviewedWorker();
  process.stdout.write(`${JSON.stringify({
    status: "deployed",
    sourceCommit: result.sourceCommit,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const code = error instanceof DeploymentError
      ? error.code
      : "worker_deployment_unexpected_failure";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
