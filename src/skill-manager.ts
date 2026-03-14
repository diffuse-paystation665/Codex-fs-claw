import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Logger } from "./logger.js";
import type {
  LocalSkillInventory,
  SkillCatalogEntry,
  SkillInstallSpec,
  SkillListSource,
} from "./types.js";

const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");

interface CommandResult {
  stdout: string;
  stderr: string;
}

export class SkillManagerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SkillManagerError";
  }
}

export class SkillManager {
  private readonly logger: Logger;
  private readonly codexHome: string;
  private readonly skillsRoot: string;
  private readonly installerRoot: string;
  private readonly listScriptPath: string;
  private readonly installScriptPath: string;

  public constructor(parentLogger: Logger, codexHome = process.env.CODEX_HOME ?? DEFAULT_CODEX_HOME) {
    this.logger = parentLogger.child("skills");
    this.codexHome = codexHome;
    this.skillsRoot = path.join(this.codexHome, "skills");
    this.installerRoot = path.join(
      this.skillsRoot,
      ".system",
      "skill-installer",
    );
    this.listScriptPath = path.join(this.installerRoot, "scripts", "list-skills.py");
    this.installScriptPath = path.join(
      this.installerRoot,
      "scripts",
      "install-skill-from-github.py",
    );
  }

  public listInstalledSkills(): LocalSkillInventory {
    if (!fs.existsSync(this.skillsRoot)) {
      return { userSkills: [], systemSkills: [] };
    }

    const userSkills: string[] = [];
    const systemSkills: string[] = [];
    for (const entry of fs.readdirSync(this.skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith(".")) {
        if (entry.name === ".system") {
          systemSkills.push(
            ...fs
              .readdirSync(path.join(this.skillsRoot, entry.name), { withFileTypes: true })
              .filter((item) => item.isDirectory() && !item.name.startsWith("."))
              .map((item) => item.name)
              .sort((left, right) => left.localeCompare(right)),
          );
        }
        continue;
      }
      userSkills.push(entry.name);
    }

    userSkills.sort((left, right) => left.localeCompare(right));
    return { userSkills, systemSkills };
  }

  public async listRemoteSkills(source: Exclude<SkillListSource, "local">): Promise<SkillCatalogEntry[]> {
    this.ensureInstallerScripts();
    const repoPath =
      source === "experimental" ? "skills/.experimental" : "skills/.curated";

    const result = await this.runPythonScript(this.listScriptPath, [
      "--path",
      repoPath,
      "--format",
      "json",
    ]);

    try {
      const parsed = JSON.parse(result.stdout) as Array<{
        name?: unknown;
        installed?: unknown;
      }>;
      return parsed
        .filter((item) => typeof item.name === "string")
        .map((item) => ({
          name: item.name as string,
          installed: Boolean(item.installed),
          source,
        }));
    } catch (error) {
      this.logger.warn("Failed to parse remote skill list", {
        source,
        stdout: result.stdout,
        stderr: result.stderr,
        error,
      });
      throw new SkillManagerError("无法解析官方 skill 列表。");
    }
  }

  public async installSkill(spec: SkillInstallSpec): Promise<string> {
    this.ensureInstallerScripts();
    const args = this.buildInstallArgs(spec);
    const result = await this.runPythonScript(this.installScriptPath, args);
    const output = result.stdout.trim();
    if (!output) {
      throw new SkillManagerError("安装脚本没有返回可读结果。");
    }
    return output;
  }

  public describeInstallSpec(spec: SkillInstallSpec): string {
    switch (spec.source) {
      case "curated":
        return `安装官方 curated skill：${spec.name}`;
      case "experimental":
        return `安装官方 experimental skill：${spec.name}`;
      case "url":
        return `从 GitHub 链接安装 skill：${spec.url}`;
      case "repo":
        return `从 GitHub 仓库 ${spec.repo} 安装 skill 路径 ${spec.path}`;
    }
  }

  private buildInstallArgs(spec: SkillInstallSpec): string[] {
    if (spec.source === "curated") {
      return [
        "--repo",
        "openai/skills",
        "--path",
        `skills/.curated/${spec.name}`,
      ];
    }

    if (spec.source === "experimental") {
      return [
        "--repo",
        "openai/skills",
        "--path",
        `skills/.experimental/${spec.name}`,
      ];
    }

    if (spec.source === "url") {
      return ["--url", spec.url];
    }

    const args = ["--repo", spec.repo, "--path", spec.path];
    if (spec.ref) {
      args.push("--ref", spec.ref);
    }
    if (spec.name) {
      args.push("--name", spec.name);
    }
    return args;
  }

  private ensureInstallerScripts(): void {
    if (!fs.existsSync(this.listScriptPath) || !fs.existsSync(this.installScriptPath)) {
      throw new SkillManagerError("本机缺少 skill-installer 系统 skill。");
    }
  }

  private async runPythonScript(scriptPath: string, args: string[]): Promise<CommandResult> {
    const commands =
      process.platform === "win32"
        ? [
            { command: "py", args: ["-3", scriptPath, ...args] },
            { command: "python", args: [scriptPath, ...args] },
          ]
        : [
            { command: "python3", args: [scriptPath, ...args] },
            { command: "python", args: [scriptPath, ...args] },
          ];

    let lastError: string | null = null;
    for (const candidate of commands) {
      try {
        return await this.spawnOnce(candidate.command, candidate.args);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    throw new SkillManagerError(lastError ?? "找不到可用的 Python 来执行 skill-installer。");
  }

  private spawnOnce(command: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.installerRoot,
        env: {
          ...process.env,
          CODEX_HOME: this.codexHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        reject(new SkillManagerError(`执行 ${command} 失败：${error.message}`));
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        reject(
          new SkillManagerError(
            stderr.trim() || stdout.trim() || `命令 ${command} 退出码 ${code ?? "unknown"}`,
          ),
        );
      });
    });
  }
}
